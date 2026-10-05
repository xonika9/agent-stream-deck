import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { open, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CodexHost, HostHealth, RoutedAgentSlot, TaskSource } from "#agents";
import { codexDeckStateRoot } from "../runtime/paths.js";

const TERMINAL_WINDOW_MS = 5 * 60_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
type RecordValue = Record<string, unknown>;
type Options = { configPath?: string; runtimePath?: string; foreground?: () => Promise<void> };

export class T3CodeSource {
  slots: RoutedAgentSlot[] = [];
  health: HostHealth = { state: "connecting", reason: "awaiting-snapshot", changedAt: Date.now() };
  private host?: CodexHost;
  private demanded = false;
  private generation = 0;
  private request?: AbortController;
  private readonly acknowledged = new Map<string, number>();
  private readonly configPath: string;
  private readonly runtimePath: string;
  private readonly foreground: () => Promise<void>;

  constructor(
    private readonly log: (message: string) => void,
    options: Options = {},
  ) {
    this.configPath = options.configPath ?? join(codexDeckStateRoot("darwin"), "t3code.json");
    this.runtimePath = options.runtimePath ?? join(homedir(), ".t3", "userdata", "server-runtime.json");
    this.foreground = options.foreground ?? foregroundT3Code;
  }

  syncDemand(source: TaskSource, host: CodexHost | undefined, stopped: boolean): void {
    const demanded = !stopped && host?.platform === "darwin" && (source === "T3 Code" || source === "All");
    this.host = host;
    if (demanded === this.demanded) return;
    this.demanded = demanded;
    this.generation++;
    this.request?.abort();
    this.slots = [];
    this.health = { state: "connecting", reason: "awaiting-snapshot", changedAt: Date.now() };
  }

  stop(): void {
    this.demanded = false;
    this.generation++;
    this.request?.abort();
    this.slots = [];
    this.acknowledged.clear();
  }

  async refresh(): Promise<void> {
    if (!this.demanded || !this.host) return;
    const generation = this.generation;
    this.request?.abort();
    const request = new AbortController();
    this.request = request;
    try {
      const config = await readPrivateConfig(this.configPath);
      const origin = loopbackOrigin(config.origin);
      const token = config.token;
      if (typeof token !== "string" || !/^[A-Za-z0-9._~+/-]{1,8192}={0,2}$/u.test(token))
        throw new Error("Invalid token");
      const runtime = object(JSON.parse(await readFile(this.runtimePath, "utf8")));
      if (
        runtime.version !== 1 ||
        runtime.origin !== origin ||
        !Number.isSafeInteger(runtime.pid) ||
        Number(runtime.pid) <= 0
      )
        throw new Error("Invalid runtime");
      process.kill(Number(runtime.pid), 0);
      const response = await fetch(`${origin}/api/orchestration/shell`, {
        headers: { authorization: `Bearer ${token}`, "x-t3-orchestration-protocol": "2" },
        redirect: "error",
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(4_000)]),
      });
      if (!response.ok || !response.body) throw new Error("Shell unavailable");
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      for await (const chunk of response.body) {
        bytes += chunk.byteLength;
        if (bytes > MAX_RESPONSE_BYTES) {
          request.abort();
          throw new Error("Shell too large");
        }
        chunks.push(chunk);
      }
      const shell = object(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      if (!Number.isSafeInteger(shell.schemaVersion) || !Array.isArray(shell.threads) || shell.threads.length > 10_000)
        throw new Error("Unsupported shell");
      const now = Date.now();
      const slots = shell.threads.flatMap((value, index) => {
        const slot = this.taskSlot(object(value), index, now);
        return slot ? [slot] : [];
      });
      if (generation !== this.generation || request.signal.aborted) return;
      this.slots = slots;
      const present = new Set(slots.map((slot) => slot.threadKey));
      for (const [id, at] of this.acknowledged)
        if (!present.has(id) && now - at > TERMINAL_WINDOW_MS) this.acknowledged.delete(id);
      this.health = { state: "ready", changedAt: now };
    } catch {
      if (generation !== this.generation || (request.signal.aborted && this.request !== request)) return;
      const wasDegraded = this.health.state === "degraded";
      this.slots = [];
      this.health = { state: "degraded", reason: "native-signals-unavailable", changedAt: Date.now() };
      if (!wasDegraded) this.log("T3 Code task source unavailable; check the local connection.");
    } finally {
      if (this.request === request) this.request = undefined;
    }
  }

  async open(assignment: RoutedAgentSlot, signal: AbortSignal): Promise<boolean> {
    if (!this.demanded || signal.aborted) return false;
    const generation = this.generation;
    await this.foreground();
    if (signal.aborted || generation !== this.generation || !this.demanded) return false;
    const current = this.slots.find((slot) => slot.threadKey === assignment.threadKey);
    if (!current || current.activityAt !== assignment.activityAt || current.status !== assignment.status) return false;
    if ((current.status === "unread" || current.status === "error") && current.activityAt !== undefined) {
      this.acknowledged.set(current.threadKey!, current.activityAt);
      this.slots = this.slots.filter((slot) => slot !== current);
    }
    return true;
  }

  private taskSlot(thread: RecordValue, index: number, now: number): RoutedAgentSlot | null {
    if (
      typeof thread.id !== "string" ||
      !thread.id ||
      thread.id.length > 512 ||
      typeof thread.title !== "string" ||
      typeof thread.status !== "string"
    )
      throw new Error("Unsupported thread");
    if (
      thread.deletedAt ||
      thread.archivedAt ||
      thread.settledAt ||
      thread.settledOverride === "settled" ||
      (timestamp(thread.snoozedUntil) ?? 0) > now
    )
      return null;
    const workStartedAt =
      timestamp(thread.activityRunStartedAt) ??
      timestamp(thread.latestUserAuthoredMessageAt) ??
      timestamp(thread.latestRunRequestedAt);
    const terminalAt = timestamp(thread.latestRunCompletedAt);
    let status: string;
    if (thread.pendingRuntimeRequest || thread.hasActionableProposedPlan) status = "approval";
    else if (
      ["preparing", "queued", "starting", "running", "waiting"].includes(
        String(thread.activityRunStatus ?? thread.status),
      ) ||
      (Array.isArray(thread.pendingBackgroundTasks) && thread.pendingBackgroundTasks.length > 0)
    )
      status = "working";
    else if (thread.status === "completed" || thread.status === "failed") {
      if (
        terminalAt === undefined ||
        now - terminalAt > TERMINAL_WINDOW_MS ||
        terminalAt > now + 60_000 ||
        this.acknowledged.get(thread.id) === terminalAt ||
        (timestamp(thread.lastVisitedAt) ?? 0) >= terminalAt
      )
        return null;
      status = thread.status === "failed" ? "error" : "unread";
    } else return null;
    return {
      id: index,
      sourceSlot: index,
      catalogIndex: index,
      taskSource: "t3code",
      host: this.host!,
      threadKey: thread.id,
      conversationId: thread.id,
      title:
        thread.title
          .replace(/[\p{Cc}\p{Cf}]/gu, " ")
          .replace(/\s+/gu, " ")
          .trim()
          .slice(0, 160) || "T3 Code task",
      status,
      selected: false,
      activityAt: terminalAt ?? workStartedAt,
      observedAt: now,
      workStartedAt,
      workStartRevision: workStartedAt,
    };
  }
}

function object(value: unknown): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid object");
  return value as RecordValue;
}
function timestamp(value: unknown): number | undefined {
  const at = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isSafeInteger(at) && at > 0 ? at : undefined;
}
function loopbackOrigin(value: unknown): string {
  if (typeof value !== "string") throw new Error("Invalid origin");
  const url = new URL(value);
  if (url.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(url.hostname) || url.origin !== value)
    throw new Error("Only loopback origins are supported");
  return url.origin;
}
async function readPrivateConfig(path: string): Promise<RecordValue> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 16_384 || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)
      throw new Error("Unprotected configuration");
    return object(JSON.parse(await file.readFile("utf8")));
  } finally {
    await file.close();
  }
}
async function foregroundT3Code(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    execFile("/usr/bin/open", ["-b", "com.t3tools.t3code"], { timeout: 5_000 }, (error) =>
      error ? reject(new Error("T3 Code activation failed")) : resolve(),
    );
  });
}
