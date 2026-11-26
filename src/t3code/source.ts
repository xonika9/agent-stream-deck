import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { open, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { CodexHost, HostHealth, RoutedAgentSlot, TaskSource, TaskSourceSet } from "#agents";
import { toTaskSourceSet } from "#agents";
import { agentDeckStateRoot } from "../runtime/paths.js";

import { T3CredentialRejectedError, T3SshUnavailableError, t3SshRequest, validateSshConnection } from "./ssh.js";
import { readShell } from "./shell-reader.js";
import { type ThreadRef, sidebarThreads, staysUntilRead } from "./sidebar.js";

const TERMINAL_WINDOW_MS = 5 * 60_000;
const MAX_ACKNOWLEDGED = 1_000;
// Each SSH read makes the remote T3 server serialize its whole shell, so remote environments start
// at most this often instead of on every caller tick; the local loopback read keeps the caller cadence.
const SSH_READ_INTERVAL_MS = 5_000;
// T3 builds only the threads that survive these trims. Keys never show what they drop: settled
// threads, and idle subagents, which reach a key only while they ask the user and so stay live.
const SHELL_PATH = "/api/orchestration/shell?omitIdleSubagents=1&omitOlderSettled=1";
export type LocalConnection = { origin: string; token: string; pid: number };
export type LocalConnectionOptions = { configPath?: string; runtimePath?: string };

export function defaultT3ConfigPath(): string {
  return join(agentDeckStateRoot("darwin"), "t3code.json");
}

export function defaultT3RuntimePath(): string {
  return join(homedir(), ".t3", "userdata", "server-runtime.json");
}

export async function readLocalConnection(options: LocalConnectionOptions = {}): Promise<LocalConnection> {
  const config = await readPrivateConfig(options.configPath ?? defaultT3ConfigPath());
  return validateLocalRuntime(config, options.runtimePath ?? defaultT3RuntimePath());
}

export async function validateLocalRuntime(config: RecordValue, runtimePath: string): Promise<LocalConnection> {
  const origin = loopbackOrigin(config.origin);
  const token = config.token;
  if (typeof token !== "string" || !/^[A-Za-z0-9._~+/-]{1,8192}={0,2}$/u.test(token)) throw new Error("Invalid token");
  const runtime = object(JSON.parse(await readFile(runtimePath, "utf8")));
  if (
    runtime.version !== 1 ||
    runtime.origin !== origin ||
    !Number.isSafeInteger(runtime.pid) ||
    Number(runtime.pid) <= 0
  )
    throw new Error("Invalid runtime");
  process.kill(Number(runtime.pid), 0);
  return { origin, token, pid: Number(runtime.pid) };
}
type RecordValue = Record<string, unknown>;
type Options = { configPath?: string; runtimePath?: string; foreground?: (threadUrl?: string) => Promise<void> };
type LocalRuntime = { origin: string; token: string; pid: number };
type FailureReason = "credential-rejected" | "runtime-unavailable" | "timeout" | "ssh-unavailable" | "invalid-response";
type Environment = {
  namespace: string;
  environmentId?: string;
  // Log label: "local" or an SSH ordinal; never a host, identity or token.
  label: string;
  identity: string;
  read: (request: AbortController) => Promise<RecordValue>;
  readInterval: number;
  nextReadAt?: number;
  slots: RoutedAgentSlot[];
  // Slots to hide while the thread that delegated them is in the queue.
  delegations: Map<string, ThreadRef>;
  state: "connecting" | "ready" | "degraded";
  request?: AbortController;
  pending?: Promise<void>;
};

export class T3CodeSource {
  slots: RoutedAgentSlot[] = [];
  health: HostHealth = { state: "connecting", reason: "awaiting-snapshot", changedAt: Date.now() };
  private host?: CodexHost;
  private demanded = false;
  private generation = 0;
  private preparation?: Promise<void>;
  private configurationFailed = false;
  private readonly environments = new Map<string, Environment>();
  private readonly listeners = new Set<() => void>();
  private readonly acknowledged = new Map<string, number>();
  // Last reported failure per log label, so each transition is logged once.
  private readonly reportedFailures = new Map<string, FailureReason>();
  private readonly configPath: string | undefined;
  private readonly runtimePath: string;
  private readonly foreground: (threadUrl?: string) => Promise<void>;

  constructor(
    private readonly log: (message: string) => void,
    options: Options = {},
  ) {
    this.configPath = options.configPath;
    this.runtimePath = options.runtimePath ?? join(homedir(), ".t3", "userdata", "server-runtime.json");
    this.foreground = options.foreground ?? foregroundT3Code;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  syncDemand(source: TaskSourceSet | TaskSource, host: CodexHost | undefined, stopped: boolean): void {
    const demanded = !stopped && host?.platform === "darwin" && toTaskSourceSet(source).has("T3 Code");
    const hostChanged = this.host?.hostId !== host?.hostId;
    this.host = host;
    if (demanded === this.demanded && !hostChanged) return;
    this.demanded = demanded;
    this.generation++;
    this.resetEnvironments();
    this.preparation = undefined;
    this.configurationFailed = false;
    this.reportedFailures.clear();
    this.publish();
    if (demanded) void this.refresh();
  }

  stop(): void {
    this.demanded = false;
    this.generation++;
    this.resetEnvironments();
    this.preparation = undefined;
    this.configurationFailed = false;
    this.reportedFailures.clear();
    this.acknowledged.clear();
    this.publish();
  }

  // The caller supplies its existing cadence; each environment owns its pending work and commit.
  refresh(): Promise<void> {
    if (!this.demanded || !this.host) return Promise.resolve();
    if (this.preparation) return this.preparation;
    const generation = this.generation;
    const preparation = this.prepare(generation).finally(() => {
      if (this.preparation === preparation) this.preparation = undefined;
    });
    this.preparation = preparation;
    return preparation;
  }

  private async prepare(generation: number): Promise<void> {
    try {
      const config = await readPrivateConfig(this.configPath ?? defaultT3ConfigPath());
      if (generation !== this.generation || !this.demanded) return;
      const desired = new Map<
        string,
        Pick<Environment, "environmentId" | "label" | "identity" | "read" | "readInterval">
      >();
      try {
        const runtime = await this.localRuntime(config);
        const environmentId = await readLocalEnvironmentId(this.runtimePath);
        desired.set("", {
          environmentId,
          label: "local",
          identity: JSON.stringify([runtime.origin, runtime.token, runtime.pid, environmentId]),
          read: async (request) => this.localShell(runtime, request),
          readInterval: 0,
        });
      } catch {
        desired.set("", {
          label: "local",
          identity: "unavailable",
          read: async () => {
            throw new LocalRuntimeUnavailableError("Local runtime unavailable");
          },
          readInterval: 0,
        });
      }
      if (generation !== this.generation || !this.demanded) return;
      let configurationFailed = false;
      if (config.sshConnections !== undefined) {
        if (!Array.isArray(config.sshConnections) || config.sshConnections.length > 8) configurationFailed = true;
        else
          for (const [index, value] of config.sshConnections.entries()) {
            try {
              const connection = validateSshConnection(value);
              const namespace = `ssh:${connection.environmentId}:`;
              if (desired.has(namespace)) throw new Error("Duplicate T3 environment");
              desired.set(namespace, {
                environmentId: connection.environmentId,
                label: `SSH connection ${index + 1}`,
                identity: JSON.stringify([connection.host, connection.environmentId, connection.token]),
                read: async (request) => object(await t3SshRequest(connection.host, connection, request.signal)),
                readInterval: SSH_READ_INTERVAL_MS,
              });
            } catch {
              configurationFailed = true;
            }
          }
      }
      if (configurationFailed && !this.configurationFailed)
        this.log("T3 Code saved SSH connections are invalid; reconnect with npm run connect:t3:ssh.");
      let changed = this.configurationFailed !== configurationFailed;
      this.configurationFailed = configurationFailed;
      for (const [namespace, environment] of this.environments) {
        if (desired.get(namespace)?.identity === environment.identity) continue;
        environment.request?.abort();
        this.environments.delete(namespace);
        changed = true;
      }
      for (const [namespace, candidate] of desired) {
        if (this.environments.has(namespace)) continue;
        this.environments.set(namespace, {
          namespace,
          ...candidate,
          slots: [],
          delegations: new Map(),
          state: "connecting",
        });
        changed = true;
      }
      if (changed) this.publish();
      for (const environment of this.environments.values()) this.collect(environment, generation);
    } catch {
      if (generation !== this.generation || !this.demanded) return;
      const wasDegraded = this.health.state === "degraded";
      this.resetEnvironments();
      this.configurationFailed = true;
      this.publish();
      if (!wasDegraded) this.log("T3 Code task source unavailable; check the local connection.");
    }
  }

  private collect(environment: Environment, generation: number): void {
    const now = Date.now();
    if (environment.pending || now < (environment.nextReadAt ?? 0)) return;
    environment.nextReadAt = now + environment.readInterval;
    const request = new AbortController();
    environment.request = request;
    const current = () =>
      generation === this.generation &&
      this.demanded &&
      this.environments.get(environment.namespace) === environment &&
      !request.signal.aborted;
    const pending = (async () => {
      try {
        const shell = await environment.read(request);
        if (
          !Number.isSafeInteger(shell.schemaVersion) ||
          !Array.isArray(shell.threads) ||
          shell.threads.length > 10_000
        )
          throw new Error("Unsupported shell");
        const observedAt = Date.now();
        const delegations = new Map<string, ThreadRef>();
        const candidate = sidebarThreads(
          shell.threads.map(object),
          (thread) => this.taskSlot(thread, 0, observedAt, environment.namespace) !== null,
        ).flatMap(({ thread, asked, delegatedFrom }, index) => {
          const slot = this.taskSlot(thread, index, observedAt, environment.namespace);
          if (!slot) return [];
          if (delegatedFrom && !asked) delegations.set(slot.threadKey!, delegatedFrom);
          return [asked ? { ...slot, status: "approval" } : slot];
        });
        if (!current()) return;
        // Recheck the exact acknowledgement at commit, including the environment namespace.
        environment.slots = candidate.filter(
          (slot) =>
            (slot.status !== "unread" && slot.status !== "error") ||
            this.acknowledged.get(slot.threadKey!) !== slot.activityAt,
        );
        environment.delegations = delegations;
        environment.state = "ready";
        if (this.reportedFailures.delete(environment.label))
          this.log(`T3 Code ${environment.label} connection recovered.`);
        this.publish();
      } catch (error) {
        if (!current()) return;
        this.reportFailure(environment.label, failureReason(error));
        if (!(error instanceof Error && error.name === "TimeoutError" && environment.state === "ready"))
          environment.slots = [];
        environment.state = "degraded";
        this.publish();
      }
    })().finally(() => {
      if (environment.pending === pending) {
        environment.pending = undefined;
        environment.request = undefined;
      }
    });
    environment.pending = pending;
  }

  private reportFailure(label: string, reason: FailureReason): void {
    if (this.reportedFailures.get(label) === reason) return;
    this.reportedFailures.set(label, reason);
    const reconnect = label === "local" ? "npm run connect:t3" : "npm run connect:t3:ssh";
    const detail = {
      "credential-rejected": `credential rejected; reconnect with ${reconnect}`,
      "runtime-unavailable": "server is not running or its port changed",
      timeout: "request timed out",
      "ssh-unavailable": "SSH request or remote T3 server failed",
      "invalid-response": "response is unsupported or too large",
    }[reason];
    this.log(`T3 Code ${label} connection unavailable: ${detail}.`);
  }

  private resetEnvironments(): void {
    for (const environment of this.environments.values()) environment.request?.abort();
    this.environments.clear();
  }

  private publish(): void {
    this.slots = this.visibleSlots();
    const now = Date.now();
    const environments = [...this.environments.values()];
    const state =
      this.configurationFailed || environments.some((environment) => environment.state === "degraded")
        ? "degraded"
        : !environments.length || environments.some((environment) => environment.state === "connecting")
          ? "connecting"
          : "ready";
    if (this.health.state !== state) {
      this.health =
        state === "ready"
          ? { state, changedAt: now }
          : {
              state,
              reason: state === "connecting" ? "awaiting-snapshot" : "native-signals-unavailable",
              changedAt: now,
            };
    }
    for (const listener of this.listeners) listener();
  }

  private visibleSlots(): RoutedAgentSlot[] {
    const environments = [...this.environments.values()];
    const queued = (ref: ThreadRef) =>
      environments.some(
        ({ environmentId, namespace, slots }) =>
          environmentId === ref.environmentId && slots.some((slot) => slot.threadKey === namespace + ref.threadId),
      );
    return environments.flatMap(({ slots, delegations }) =>
      slots.filter((slot) => {
        const delegatedFrom = delegations.get(slot.threadKey!);
        return !delegatedFrom || !queued(delegatedFrom);
      }),
    );
  }

  private async localRuntime(config: RecordValue): Promise<LocalRuntime> {
    return validateLocalRuntime(config, this.runtimePath);
  }

  private async localShell(runtime: LocalRuntime, request: AbortController): Promise<RecordValue> {
    const { origin, token } = runtime;
    const response = await fetch(`${origin}${SHELL_PATH}`, {
      headers: { authorization: `Bearer ${token}`, "x-t3-orchestration-protocol": "2" },
      redirect: "error",
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(4_000)]),
    }).catch((error: unknown) => {
      if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) throw error;
      throw new LocalRuntimeUnavailableError("Local server unreachable");
    });
    if (response.status === 401 || response.status === 403)
      throw new T3CredentialRejectedError("Shell credential rejected");
    if (!response.ok || !response.body) throw new Error("Shell unavailable");
    const now = Date.now();
    return readShell(response.body, (thread) => this.taskSlot(thread, 0, now) !== null);
  }

  async open(assignment: RoutedAgentSlot, signal: AbortSignal): Promise<boolean> {
    if (!this.demanded || signal.aborted) return false;
    const generation = this.generation;
    await this.foreground(this.threadUrl(assignment.threadKey));
    if (signal.aborted || generation !== this.generation || !this.demanded) return false;
    const current = this.slots.find((slot) => slot.threadKey === assignment.threadKey);
    if (!current || current.activityAt !== assignment.activityAt || current.status !== assignment.status) return false;
    if ((current.status === "unread" || current.status === "error") && current.activityAt !== undefined) {
      // A result may stay unread in T3 indefinitely, so a press is forgotten by count rather than by age.
      this.acknowledged.delete(current.threadKey!);
      this.acknowledged.set(current.threadKey!, current.activityAt);
      if (this.acknowledged.size > MAX_ACKNOWLEDGED) this.acknowledged.delete(this.acknowledged.keys().next().value!);
      for (const environment of this.environments.values())
        environment.slots = environment.slots.filter((slot) => slot !== current);
      this.publish();
    }
    return true;
  }

  // Undefined leaves the press at bringing T3 Code forward.
  private threadUrl(threadKey: RoutedAgentSlot["threadKey"]): string | undefined {
    const environment = [...this.environments.values()].find(({ slots }) =>
      slots.some((slot) => slot.threadKey === threadKey),
    );
    if (!threadKey || !environment?.environmentId) return undefined;
    const threadId = threadKey.slice(environment.namespace.length);
    return `t3code://threads/${encodeURIComponent(environment.environmentId)}/${encodeURIComponent(threadId)}`;
  }

  private taskSlot(thread: RecordValue, index: number, now: number, namespace = ""): RoutedAgentSlot | null {
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
        (now - terminalAt > TERMINAL_WINDOW_MS && !staysUntilRead(thread)) ||
        terminalAt > now + 60_000 ||
        this.acknowledged.get(namespace + thread.id) === terminalAt ||
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
      threadKey: namespace + thread.id,
      conversationId: namespace + thread.id,
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

class LocalRuntimeUnavailableError extends Error {
  override name = "LocalRuntimeUnavailableError";
}

function failureReason(error: unknown): FailureReason {
  if (error instanceof T3CredentialRejectedError) return "credential-rejected";
  if (error instanceof LocalRuntimeUnavailableError) return "runtime-unavailable";
  if (error instanceof Error && error.name === "TimeoutError") return "timeout";
  if (error instanceof T3SshUnavailableError) return "ssh-unavailable";
  return "invalid-response";
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
export async function readPrivateConfig(path: string): Promise<RecordValue> {
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
async function readLocalEnvironmentId(runtimePath: string): Promise<string | undefined> {
  const value = await readFile(join(dirname(runtimePath), "environment-id"), "utf8").catch(() => "");
  return /^[A-Za-z0-9-]{1,128}$/u.exec(value.trim())?.[0];
}
async function foregroundT3Code(threadUrl?: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const target = threadUrl ? [threadUrl] : [];
    execFile("/usr/bin/open", ["-b", "com.t3tools.t3code", ...target], { timeout: 5_000 }, (error) =>
      error ? reject(new Error("T3 Code activation failed")) : resolve(),
    );
  });
}
