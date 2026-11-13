import WebSocket from "ws";
import type { HostHealth, UsageSnapshot, UsageWindow, UsageWindowKind } from "#agents";
import { clampPercent, FIVE_HOUR_MINUTES, WEEKLY_MINUTES } from "#usage";
import { readLocalConnection, type LocalConnection, type LocalConnectionOptions } from "./source.js";

const REQUEST_TIMEOUT_MS = 5_000;
const MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;
const FRESH_MS = 5 * 60_000;

export type T3UsageProvider = "t3-codex" | "t3-claude" | "t3-opencode";
export type T3UsageSnapshots = Partial<Record<T3UsageProvider, UsageSnapshot>>;
export type T3UsageReaderOptions = LocalConnectionOptions;

type FailureReason =
  | "credential-rejected"
  | "runtime-unavailable"
  | "timeout"
  | "invalid-response"
  | "unsupported-platform";

const DRIVERS: Record<string, T3UsageProvider> = {
  codex: "t3-codex",
  claudeAgent: "t3-claude",
  opencode: "t3-opencode",
};

export class T3UsageReader {
  snapshots: T3UsageSnapshots = {};
  health: HostHealth = { state: "connecting", reason: "awaiting-snapshot", changedAt: Date.now() };
  private pending?: Promise<void>;
  private lastReadyAt = 0;
  private readonly reported = new Map<FailureReason, true>();

  constructor(
    private readonly log: (message: string) => void,
    private readonly options: T3UsageReaderOptions = {},
  ) {}

  refresh(): Promise<void> {
    if (this.pending) return this.pending;
    const pending = this.poll().finally(() => {
      if (this.pending === pending) this.pending = undefined;
    });
    this.pending = pending;
    return pending;
  }

  private async poll(): Promise<void> {
    if (process.platform === "win32") {
      this.enterOffline("unsupported-platform");
      return;
    }
    const startedAt = Date.now();
    const remaining = () => REQUEST_TIMEOUT_MS - (Date.now() - startedAt);
    let connection: LocalConnection;
    try {
      connection = await readLocalConnection(this.options);
    } catch {
      this.enterOffline("runtime-unavailable");
      return;
    }
    let ticket: string;
    try {
      ticket = await this.requestTicket(connection, remaining());
    } catch (error) {
      if (error instanceof T3UsageCredentialError) this.enterOffline("credential-rejected");
      else if (isTimeout(error)) this.enterDegraded("timeout");
      else this.enterDegraded("invalid-response");
      return;
    }
    try {
      const providers = await this.requestProviders(connection.origin, ticket, remaining());
      this.enterReady(this.normalize(providers));
    } catch (error) {
      if (isTimeout(error)) this.enterDegraded("timeout");
      else this.enterDegraded("invalid-response");
    }
  }

  private async requestTicket(connection: LocalConnection, timeoutMs: number): Promise<string> {
    if (timeoutMs <= 0) throw timeoutError();
    let response: Response;
    try {
      response = await fetch(`${connection.origin}/api/auth/websocket-ticket`, {
        method: "POST",
        headers: { authorization: `Bearer ${connection.token}` },
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError"))
        throw timeoutError();
      throw new Error("Ticket request failed");
    }
    if (response.status === 401 || response.status === 403) throw new T3UsageCredentialError();
    if (!response.ok) throw new Error("Ticket request failed");
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new Error("Ticket request failed");
    }
    if (!body || typeof body !== "object" || typeof (body as { ticket?: unknown }).ticket !== "string")
      throw new Error("Ticket request failed");
    const ticket = (body as { ticket: string }).ticket;
    if (!ticket) throw new Error("Ticket request failed");
    return ticket;
  }

  private requestProviders(origin: string, ticket: string, timeoutMs: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (timeoutMs <= 0) {
        reject(timeoutError());
        return;
      }
      let settled = false;
      const url = new URL("/ws", origin.replace(/^http:/u, "ws:"));
      url.searchParams.set("orchestrationProtocol", "2");
      url.searchParams.set("wsTicket", ticket);
      const socket = new WebSocket(url.toString(), { maxPayload: MAX_PAYLOAD_BYTES });
      const timer = setTimeout(() => {
        fail(timeoutError());
      }, timeoutMs);
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          socket.terminate();
        } catch {
          // The socket is already gone; the error above carries the outcome.
        }
        reject(error);
      };
      socket.on("open", () => {
        try {
          socket.send(JSON.stringify({ _tag: "Request", id: "1", tag: "server.getConfig", payload: {}, headers: [] }));
        } catch {
          fail(new Error("Usage request failed"));
        }
      });
      socket.on("message", (raw) => {
        let frame: { _tag?: unknown; requestId?: unknown; exit?: unknown } | undefined;
        try {
          const parsed: unknown = JSON.parse(String(raw));
          if (parsed && typeof parsed === "object") frame = parsed as { _tag?: unknown };
        } catch {
          return;
        }
        if (!frame || frame._tag === "Ping") {
          if (frame?._tag === "Ping") {
            try {
              socket.send(JSON.stringify({ _tag: "Pong" }));
            } catch {
              // A missed pong only delays the Exit; the request timeout still bounds the poll.
            }
          }
          return;
        }
        if (frame._tag !== "Exit" || frame.requestId !== "1" || settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          socket.close();
        } catch {
          // Closing is best effort; the Exit frame already carries the outcome.
        }
        const exit = (frame as { exit?: unknown }).exit;
        if (!exit || typeof exit !== "object" || (exit as { _tag?: unknown })._tag !== "Success") {
          reject(new Error("Usage request failed"));
          return;
        }
        resolve((exit as { value?: unknown }).value);
      });
      socket.on("error", () => {
        fail(new Error("Usage request failed"));
      });
      socket.on("close", () => {
        fail(new Error("Usage request failed"));
      });
    });
  }

  private normalize(value: unknown): T3UsageSnapshots {
    if (!value || typeof value !== "object" || !Array.isArray((value as { providers?: unknown }).providers))
      throw new Error("Usage response is unsupported");
    const snapshots: T3UsageSnapshots = {};
    for (const entry of (value as { providers: unknown[] }).providers) {
      const normalized = normalizeProvider(entry);
      if (normalized) snapshots[normalized.key] = normalized.snapshot;
    }
    return snapshots;
  }

  private enterReady(snapshots: T3UsageSnapshots): void {
    this.snapshots = snapshots;
    this.lastReadyAt = Date.now();
    if (this.reported.size > 0) {
      this.reported.clear();
      this.log("T3 usage connection recovered.");
    }
    this.setHealth({ state: "ready", changedAt: Date.now() });
  }

  private enterOffline(reason: FailureReason): void {
    this.snapshots = {};
    this.reportFailure(reason);
    this.setHealth({ state: "offline", changedAt: Date.now() });
  }

  private enterDegraded(reason: FailureReason): void {
    if (Date.now() - this.lastReadyAt > FRESH_MS) this.snapshots = {};
    this.reportFailure(reason);
    this.setHealth({ state: "degraded", reason: "snapshot-stale", changedAt: Date.now() });
  }

  private reportFailure(reason: FailureReason): void {
    if (this.reported.has(reason)) return;
    this.reported.set(reason, true);
    const detail = {
      "credential-rejected": "credential rejected; reconnect with npm run connect:t3",
      "runtime-unavailable": "server is not running or its port changed",
      timeout: "request timed out",
      "invalid-response": "response is unsupported or too large",
      "unsupported-platform": "usage limits are available on macOS only",
    }[reason];
    this.log(`T3 usage connection unavailable: ${detail}.`);
  }

  private setHealth(health: HostHealth): void {
    if (this.health.state !== health.state) this.health = health;
    else if (health.state !== "ready") this.health = { ...health, changedAt: this.health.changedAt };
  }
}

class T3UsageCredentialError extends Error {
  override name = "T3UsageCredentialError";
}

function timeoutError(): Error {
  return new DOMException("Usage request timed out", "TimeoutError");
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}

function normalizeProvider(entry: unknown): { key: T3UsageProvider; snapshot: UsageSnapshot } | null {
  if (!entry || typeof entry !== "object") return null;
  const record = entry as Record<string, unknown>;
  if (typeof record.driver !== "string") return null;
  const key = DRIVERS[record.driver];
  if (!key) return null;
  if (record.usageLimits == null || typeof record.usageLimits !== "object") return null;
  const limits = record.usageLimits as Record<string, unknown>;
  const observedAt = parseTime(limits.checkedAt) ?? Date.now();
  const credits = normalizeResetCredits(limits.resetCredits);
  if (limits.unavailable != null && typeof limits.unavailable === "object")
    return {
      key,
      snapshot: { windows: [], observedAt, resetCreditsAvailable: null, resetCreditsApplicable: null },
    };
  if (!Array.isArray(limits.windows)) return null;
  const windows = limits.windows.flatMap((window) => {
    const normalized = normalizeWindow(window);
    return normalized ? [normalized] : [];
  });
  return {
    key,
    snapshot: {
      windows,
      observedAt,
      resetCreditsAvailable: credits.available,
      resetCreditsApplicable: credits.applicable,
    },
  };
}

function normalizeWindow(window: unknown): UsageWindow | null {
  if (!window || typeof window !== "object") return null;
  const record = window as Record<string, unknown>;
  if (typeof record.id !== "string" || !record.id) return null;
  if (typeof record.kind !== "string") return null;
  if (typeof record.usedPercent !== "number" || !Number.isFinite(record.usedPercent)) return null;
  const duration =
    typeof record.windowDurationMins === "number" && Number.isFinite(record.windowDurationMins)
      ? record.windowDurationMins
      : null;
  const usedPercent = clampPercent(record.usedPercent);
  return {
    id: record.id,
    kind: normalizeWindowKind(record.id, record.kind, duration),
    usedPercent,
    remainingPercent: 100 - usedPercent,
    windowDurationMins: duration,
    resetsAt: parseTime(record.resetsAt),
  };
}

function normalizeWindowKind(id: string, kind: string, durationMins: number | null): UsageWindowKind {
  if (kind === "monthly") return "monthly";
  if (kind === "session" && durationMins != null && Math.abs(durationMins - FIVE_HOUR_MINUTES) <= 1) return "five-hour";
  if (kind === "weekly" && durationMins != null && Math.abs(durationMins - WEEKLY_MINUTES) <= 1)
    return id === "seven_day_fable" ? "weekly-fable" : "weekly";
  return "other";
}

function normalizeResetCredits(value: unknown): { available: number | null; applicable: number | null } {
  if (!value || typeof value !== "object") return { available: null, applicable: null };
  const record = value as Record<string, unknown>;
  const count = (field: string) =>
    typeof record[field] === "number" && Number.isFinite(record[field]) ? (record[field] as number) : null;
  return { available: count("availableCount"), applicable: count("applicableCount") };
}

function parseTime(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const at = Date.parse(value);
  return Number.isSafeInteger(at) && at > 0 ? at : null;
}
