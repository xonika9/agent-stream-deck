import { timingSafeEqual } from "node:crypto";
import { isAllowedRelayHost } from "./relay-network.js";
import { WebSocketServer, WebSocket } from "ws";
import type { OfficialKeycapId } from "./keycaps.js";
import type { CodexMicroRendererBridge } from "./codex-micro-renderer-bridge.js";
import {
  RELAY_CAPABILITIES, RELAY_PROTOCOL_VERSION, parseRelayCommand,
  type RelayAuthMessage, type RelayCommand, type RelayCommandMessage, type RelayHealthMessage,
  type RelayResultMessage, type RelaySnapshotMessage
} from "./relay-protocol.js";
import type { CodexHost } from "./types.js";

const RELAY_MAX_PAYLOAD_BYTES = 64 * 1024;

export type RelayServerConfig = {
  enabled: boolean;
  listenHost: string;
  port: number;
  token: string;
};

type RelayControl = Pick<CodexMicroRendererBridge,
  "refresh" | "sendAgent" | "sendAction" | "sendJoystick" | "sendEncoder" | "adjustReasoning" | "runKeycap" | "consumeRateLimitReset">;

export class CodexRelayServer {
  private server?: WebSocketServer;
  private poll?: NodeJS.Timeout;
  private snapshotInFlight?: Promise<RelaySnapshotMessage>;
  private readonly authenticated = new Set<WebSocket>();
  private lastSnapshotError = "";
  private lastSnapshotErrorAt = 0;
  private degraded = false;
  private hasPublishedSnapshot = false;
  private consecutiveSnapshotFailures = 0;

  constructor(
    private readonly config: RelayServerConfig,
    private host: CodexHost,
    private readonly control: RelayControl,
    private readonly log: (message: string) => void
  ) {
    validateRelayServerConfig(config);
  }

  updateHost(host: CodexHost): void {
    if (host.hostId !== this.host.hostId || host.platform !== this.host.platform) {
      throw new Error("Relay host identity cannot change while the server is running.");
    }
    this.host = host;
  }

  async start(): Promise<void> {
    if (this.server) return;
    await this.startBound(this.config.listenHost);
    // Authentication publishes an immediate first snapshot. Starting the
    // periodic poll at its normal cadence avoids racing a duplicate snapshot
    // into a newly connected client.
    this.scheduleSnapshot();
  }

  async close(): Promise<void> {
    if (this.poll) clearTimeout(this.poll);
    this.poll = undefined;
    await this.closeBound();
  }

  private async startBound(host: string): Promise<void> {
    const websocketOptions = { maxPayload: 64 * 1024, perMessageDeflate: false } as const;
    const server = new WebSocketServer({ host, port: this.config.port, ...websocketOptions });
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    this.server = server;
    server.on("connection", (socket) => this.handleConnection(socket));
    server.on("error", (error) => this.log(`Relay server error: ${String(error)}`));
    this.log(`Relay listening on ${host}:${this.config.port}; CDP remains loopback-only.`);
  }

  private async closeBound(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    for (const socket of server?.clients ?? []) socket.terminate();
    this.authenticated.clear();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private handleConnection(socket: WebSocket): void {
    const authTimer = setTimeout(() => socket.close(4001, "authentication required"), 3_000);
    socket.once("message", (raw) => {
      clearTimeout(authTimer);
      const auth = safeJson(raw.toString()) as Partial<RelayAuthMessage> | null;
      if (!auth || auth.type !== "auth" || auth.protocol !== RELAY_PROTOCOL_VERSION || !secureEqual(auth.token, this.config.token)) {
        socket.close(4003, "authentication failed");
        return;
      }
      this.authenticated.add(socket);
      socket.send(JSON.stringify({
        type: "ready", protocol: RELAY_PROTOCOL_VERSION, host: this.host,
        capabilities: RELAY_CAPABILITIES, bridge: "native-codex-micro"
      }));
      socket.on("message", (message) => {
        void this.handleMessage(socket, message.toString()).catch((error) => this.reportSnapshotError(error));
      });
      socket.on("close", () => this.authenticated.delete(socket));
      socket.on("error", () => this.authenticated.delete(socket));
      void this.publishSnapshot(socket).catch((error) => this.handleSnapshotFailure(error, socket));
    });
    socket.on("close", () => clearTimeout(authTimer));
  }

  private async handleMessage(socket: WebSocket, raw: string): Promise<void> {
    const message = safeJson(raw) as Partial<RelayCommandMessage> | null;
    if (!message || message.type !== "command" || message.protocol !== RELAY_PROTOCOL_VERSION || typeof message.requestId !== "string") return;
    const command = parseRelayCommand(message.command);
    if (!command) {
      this.sendResult(socket, message.requestId, false, "Invalid relay command.");
      return;
    }
    const startedAt = Date.now();
    const commandLabel = command.kind === "agent"
      ? `agent:${command.slot + 1}:${command.act === 1 ? "down" : "up"}`
      : command.kind;
    this.log(`Relay command ${commandLabel} received.`);
    try {
      await executeRelayCommand(this.control, command);
      this.sendResult(socket, message.requestId, true);
      this.log(`Relay command ${commandLabel} completed in ${Date.now() - startedAt} ms.`);
      await this.publishSnapshot();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.log(`Relay command ${commandLabel} failed in ${Date.now() - startedAt} ms: ${errorMessage}`);
      this.sendResult(socket, message.requestId, false, errorMessage);
    }
  }

  private sendResult(socket: WebSocket, requestId: string, ok: boolean, error?: string): void {
    if (socket.readyState !== WebSocket.OPEN) return;
    const result: RelayResultMessage = { type: "result", protocol: RELAY_PROTOCOL_VERSION, requestId, ok, ...(error ? { error } : {}) };
    socket.send(JSON.stringify(result));
  }

  private scheduleSnapshot(delay = 1_200): void {
    if (!this.server) return;
    this.poll = setTimeout(async () => {
      try { if (this.authenticated.size) await this.publishSnapshot(); }
      catch (error) { this.handleSnapshotFailure(error); }
      finally { this.scheduleSnapshot(); }
    }, delay);
  }

  private reportSnapshotError(error: unknown): void {
    const message = String(error);
    const now = Date.now();
    if (message === this.lastSnapshotError && now - this.lastSnapshotErrorAt < 60_000) return;
    this.lastSnapshotError = message;
    this.lastSnapshotErrorAt = now;
    this.log(`Relay snapshot unavailable: ${message}`);
  }

  private handleSnapshotFailure(error: unknown, only?: WebSocket): void {
    this.reportSnapshotError(error);
    this.consecutiveSnapshotFailures += 1;
    if (!relaySnapshotFailureShouldDegrade(
      this.hasPublishedSnapshot, this.consecutiveSnapshotFailures
    )) return;
    const health: RelayHealthMessage = {
      type: "health",
      protocol: RELAY_PROTOCOL_VERSION,
      host: this.host,
      state: "degraded",
      reason: "native-signals-unavailable",
      observedAt: Date.now()
    };
    const encoded = JSON.stringify(health);
    const recipients = !this.degraded ? this.authenticated : only ? new Set([only]) : [];
    this.degraded = true;
    for (const socket of recipients) {
      if (socket.readyState === WebSocket.OPEN) socket.send(encoded);
    }
  }

  private async publishSnapshot(only?: WebSocket): Promise<void> {
    const message = await this.currentSnapshotMessage();
    const encoded = encodeRelaySnapshotMessage(message);
    if (this.consecutiveSnapshotFailures > 0) {
      this.log(`Relay snapshot recovered after ${this.consecutiveSnapshotFailures} transient failure${this.consecutiveSnapshotFailures === 1 ? "" : "s"}.`);
    }
    this.consecutiveSnapshotFailures = 0;
    this.hasPublishedSnapshot = true;
    this.degraded = false;
    this.lastSnapshotError = "";
    this.lastSnapshotErrorAt = 0;
    for (const socket of only ? [only] : this.authenticated) {
      if (socket.readyState === WebSocket.OPEN) socket.send(encoded);
    }
  }

  private async currentSnapshotMessage(): Promise<RelaySnapshotMessage> {
    if (this.snapshotInFlight) return this.snapshotInFlight;
    const pending = this.control.refresh().then((snapshot): RelaySnapshotMessage => ({
      type: "snapshot",
      protocol: RELAY_PROTOCOL_VERSION,
      host: this.host,
      observedAt: Date.now(),
      snapshot
    }));
    this.snapshotInFlight = pending;
    try { return await pending; }
    finally { if (this.snapshotInFlight === pending) this.snapshotInFlight = undefined; }
  }
}

export function encodeRelaySnapshotMessage(message: RelaySnapshotMessage): string {
  const encoded = JSON.stringify(message);
  if (Buffer.byteLength(encoded, "utf8") <= RELAY_MAX_PAYLOAD_BYTES) return encoded;

  if (message.snapshot.activeCatalog) {
    const snapshot = { ...message.snapshot };
    delete snapshot.activeCatalog;
    const fallback = JSON.stringify({ ...message, snapshot });
    if (Buffer.byteLength(fallback, "utf8") <= RELAY_MAX_PAYLOAD_BYTES) return fallback;
  }

  throw new Error(`Relay snapshot exceeds the ${RELAY_MAX_PAYLOAD_BYTES}-byte wire payload limit.`);
}

export function relaySnapshotFailureShouldDegrade(
  hasPublishedSnapshot: boolean, consecutiveFailures: number
): boolean {
  return !hasPublishedSnapshot || consecutiveFailures >= 2;
}

export function validateRelayServerConfig(config: RelayServerConfig): void {
  if (!config.enabled) throw new Error("Relay server config is disabled.");
  const host = config.listenHost.trim();
  if (!host || !isAllowedRelayHost(host)) {
    throw new Error("Relay listenHost must be loopback or a specific Tailscale address.");
  }
  if (!Number.isInteger(config.port) || config.port < 1024 || config.port > 65_535) throw new Error("Relay port must be between 1024 and 65535.");
  if (typeof config.token !== "string" || Buffer.byteLength(config.token, "utf8") < 32) throw new Error("Relay token must contain at least 32 bytes.");
}

async function executeRelayCommand(control: RelayControl, command: RelayCommand): Promise<void> {
  if (command.kind === "agent") return control.sendAgent(command.slot, command.act, command.threadKey);
  if (command.kind === "action") return control.sendAction(command.slot, command.act);
  if (command.kind === "joystick") return control.sendJoystick(command.direction, command.distance);
  if (command.kind === "encoder") return control.sendEncoder(command.act);
  if (command.kind === "reasoning") return control.adjustReasoning(command.direction);
  if (command.kind === "rate-limit-reset") return control.consumeRateLimitReset();
  return control.runKeycap(command.keycapId as OfficialKeycapId);
}

function secureEqual(left: unknown, right: string): boolean {
  if (typeof left !== "string") return false;
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function safeJson(raw: string): unknown {
  try { return JSON.parse(raw); }
  catch { return null; }
}
