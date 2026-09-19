import { createHmac } from "node:crypto";
import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer, connect } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { nodeOpenCodeFileAccess, type OpenCodeFileAccess } from "./secure-files.js";

const REGISTRATION_LIMIT = 64 * 1024;
const SETTINGS_LIMIT = 1024 * 1024;
const RESPONSE_LIMIT = 1024 * 1024;
const PROCESS_OUTPUT_LIMIT = 128 * 1024;
const MAX_SESSIONS = 200;
const MAX_ROOTS = 100;
const MAX_ANCESTOR_DEPTH = 16;
const MAX_CONNECTIONS = 17;
const MAX_SSH_SERVERS = 16;
const FETCH_TIMEOUT_MS = 5_000;
const TERMINAL_RETENTION_MS = 5 * 60_000;
const POLL_INTERVAL_MS = 5_000;
const ID_PATTERN = /^[A-Za-z0-9._:-]{1,256}$/u;
const SSH_EXECUTABLE = "/usr/bin/ssh";

export type OpenCodeTaskStatus = "attention" | "error" | "complete" | "working";

export type OpenCodeTask = {
  source: "opencode";
  connectionId: string;
  sessionId: string;
  label: string;
  /** Bounded title for this process's local Stream Deck renderer only. */
  displayTitle?: string;
  status: OpenCodeTaskStatus;
  workStartedAt?: number;
  workStartRevision?: number;
  terminalAt?: number;
  viewedAt?: number;
};

export type OpenCodeConnectionHealth = "ready" | "unavailable" | "incompatible" | "capacity-exceeded";

export type OpenCodeConnectionSnapshot = {
  connectionId: string;
  health: OpenCodeConnectionHealth;
  complete: boolean;
  observedAt: number;
  tasks: OpenCodeTask[];
};

export type OpenCodeCollectorSnapshot = {
  version: 1;
  observedAt: number;
  connections: OpenCodeConnectionSnapshot[];
};

export interface OpenCodeProcess {
  pid: number;
  stdout: string | AsyncIterable<Uint8Array | string>;
  stderr: string | AsyncIterable<Uint8Array | string>;
  exited: Promise<number | null>;
  write(data: string | Uint8Array): void;
  end(): void;
  kill(signal: NodeJS.Signals): void;
}

export interface OpenCodeCollectorDependencies {
  homeDirectory: string;
  stateDirectory: string;
  settingsPath: string;
  currentUid?: number;
  now(): number;
  setInterval(callback: () => void, milliseconds: number): NodeJS.Timeout;
  clearInterval(timer: NodeJS.Timeout): void;
  files: OpenCodeFileAccess;
  fetch(url: string, init?: RequestInit): Promise<Response>;
  spawn(command: string, args: string[], options: { env: NodeJS.ProcessEnv; detached: boolean }): Promise<OpenCodeProcess>;
  reserveLoopbackPort(): Promise<number>;
  waitForLoopbackPort(port: number, timeoutMs: number): Promise<boolean>;
  terminateProcessGroup(process: OpenCodeProcess): Promise<void>;
}

type Registration = { id?: string; url: string; password: string; version: string; pid: number };
type SshServer = { id: string; target: string; name: string };
type Connection = {
  connectionId: string;
  endpoint: string;
  password: string;
  version: string;
  pid: number;
  authenticationProbed?: boolean;
  tunnel?: OpenCodeProcess;
};
type RawSession = {
  id: string;
  parentID?: string;
  displayTitle?: string;
  outcome?: "succeeded" | "failed" | "interrupted";
  time: { created: number; updated: number; idle?: number; viewed?: number };
};
type TerminalBinding = { sourceAt: number; localAt: number; lastSeenAt: number; acknowledged: boolean };
type LabelBinding = { ordinal: number; lastSeenAt: number };

const REMOTE_DISCOVERY_SCRIPT = String.raw`set -eu
cli=$(command -v opencode 2>/dev/null || true)
[ -n "$cli" ] || exit 0
status=$("$cli" service status 2>/dev/null || true)
[ "$status" != stopped ] || exit 0
printf 'OPENCODE_SERVICE_STATUS=%s\n' "$status"
platform=$(uname -s 2>/dev/null || true)
for file in "${"$"}{XDG_STATE_HOME:-$HOME/.local/state}"/opencode/service*.json; do
  [ -f "$file" ] || continue
  [ ! -L "$file" ] || continue
  size=$(wc -c < "$file" | tr -d ' ')
  [ "$size" -le 65536 ] || continue
  case "$platform" in
    Darwin*) uid=$(stat -f %u "$file" 2>/dev/null || true); mode=$(stat -f %Lp "$file" 2>/dev/null || true) ;;
    *) uid=$(stat -c %u "$file" 2>/dev/null || true); mode=$(stat -c %a "$file" 2>/dev/null || true) ;;
  esac
  [ "$uid" = "$(id -u)" ] || continue
  case "$mode" in 400|600) ;; *) continue ;; esac
  printf 'OPENCODE_REGISTRATION_BEGIN\n'
  cat "$file"
  printf '\nOPENCODE_REGISTRATION_END\n'
done
printf 'OPENCODE_PAIR_BEGIN\n'
"$cli" pair 2>/dev/null || true
printf '\nOPENCODE_PAIR_END\nOPENCODE_PAIR_STATUS_BEGIN\n'
"$cli" api GET /api/status 2>/dev/null || true
printf '\nOPENCODE_PAIR_STATUS_END\n'
`;

function defaultDependencies(): OpenCodeCollectorDependencies {
  const home = homedir();
  return {
    homeDirectory: home,
    stateDirectory: join(process.env.XDG_STATE_HOME ?? join(home, ".local", "state"), "opencode"),
    settingsPath: join(home, "Library", "Application Support", "ai.opencode.desktop", "opencode.settings"),
    currentUid: typeof process.getuid === "function" ? process.getuid() : undefined,
    now: Date.now,
    setInterval,
    clearInterval,
    files: nodeOpenCodeFileAccess,
    fetch,
    spawn: spawnProcess,
    reserveLoopbackPort,
    waitForLoopbackPort,
    terminateProcessGroup
  };
}

export class OpenCodeCollector {
  private readonly secret: Buffer;
  private readonly deps: OpenCodeCollectorDependencies;
  private readonly labels = new Map<string, LabelBinding>();
  private readonly terminalBindings = new Map<string, TerminalBinding>();
  private readonly tunnels = new Map<string, Connection>();
  private readonly children = new Set<OpenCodeProcess>();
  private readonly abortControllers = new Set<AbortController>();
  private nextLabel = 1;
  private interval?: NodeJS.Timeout;
  private running = false;
  private generation = 0;
  private inFlight?: Promise<OpenCodeCollectorSnapshot>;
  private current: OpenCodeCollectorSnapshot = { version: 1, observedAt: 0, connections: [] };

  constructor(options: { identitySecret: string | Uint8Array; dependencies?: Partial<OpenCodeCollectorDependencies> }) {
    this.secret = Buffer.from(options.identitySecret);
    if (this.secret.byteLength < 32) throw new Error("OpenCode identity secret must contain at least 32 bytes.");
    this.deps = { ...defaultDependencies(), ...options.dependencies };
  }

  async start(): Promise<OpenCodeCollectorSnapshot> {
    if (this.running) return this.refresh();
    this.running = true;
    this.generation++;
    const snapshot = await this.refresh();
    if (this.running) {
      this.interval = this.deps.setInterval(() => { void this.refresh().catch(() => undefined); }, POLL_INTERVAL_MS);
    }
    return snapshot;
  }

  refresh(): Promise<OpenCodeCollectorSnapshot> {
    if (!this.running) return Promise.reject(new Error("OpenCode collector is not started."));
    if (this.inFlight) return this.inFlight;
    const generation = this.generation;
    this.inFlight = this.collect(generation).finally(() => { this.inFlight = undefined; });
    return this.inFlight;
  }

  snapshot(): OpenCodeCollectorSnapshot {
    return this.current;
  }

  acknowledgeTask(connectionId: string, sessionId: string): boolean {
    const task = this.current.connections
      .flatMap((connection) => connection.tasks)
      .find((candidate) => candidate.connectionId === connectionId && candidate.sessionId === sessionId &&
        (candidate.status === "complete" || candidate.status === "error"));
    if (!task) return false;
    const binding = this.terminalBindings.get(taskIdentity(connectionId, sessionId));
    if (!binding || binding.acknowledged) return false;
    binding.acknowledged = true;
    this.current = {
      ...this.current,
      connections: this.current.connections.map((connection) => ({
        ...connection,
        tasks: connection.tasks.filter((candidate) =>
          candidate.connectionId !== connectionId || candidate.sessionId !== sessionId)
      }))
    };
    return true;
  }

  async stop(): Promise<void> {
    if (!this.running && this.tunnels.size === 0) return;
    this.running = false;
    this.generation++;
    if (this.interval) this.deps.clearInterval(this.interval);
    this.interval = undefined;
    for (const controller of this.abortControllers) controller.abort();
    this.abortControllers.clear();
    this.tunnels.clear();
    await this.terminateChildren();
    await this.inFlight?.catch(() => undefined);
    await this.terminateChildren();
  }

  private async collect(generation: number): Promise<OpenCodeCollectorSnapshot> {
    const now = this.deps.now();
    const local = await this.discoverLocal();
    const ssh = await this.discoverSsh();
    const discovered = [...local, ...ssh.connections].slice(0, MAX_CONNECTIONS);
    const results = await mapConcurrent(discovered, 3, async (connection) => {
      try {
        return await this.collectConnection(connection, now);
      } catch {
        if (connection.tunnel) {
          this.tunnels.delete(connection.connectionId);
          await this.terminateChild(connection.tunnel);
        }
        return unavailable(connection.connectionId, now);
      }
    });
    results.push(...ssh.failures.map((connectionId) => unavailable(connectionId, now)));
    const deduplicated = [...new Map(results.map((result) => [result.connectionId, result])).values()]
      .sort((left, right) => left.connectionId.localeCompare(right.connectionId));
    if (!this.running || generation !== this.generation) return this.current;
    for (const connection of deduplicated) {
      for (const task of connection.tasks) {
        const identity = taskIdentity(task.connectionId, task.sessionId);
        let binding = this.labels.get(identity);
        if (binding === undefined) {
          binding = { ordinal: this.nextLabel++, lastSeenAt: now };
          this.labels.set(identity, binding);
        } else binding.lastSeenAt = now;
        task.label = `OpenCode ${binding.ordinal}`;
      }
    }
    this.pruneLabels();
    this.pruneTerminalBindings();
    this.current = { version: 1, observedAt: now, connections: deduplicated };
    return this.current;
  }

  private async discoverLocal(): Promise<Connection[]> {
    const names = (await this.deps.files.list(this.deps.stateDirectory))
      .filter((name) => /^service(?:[._-][A-Za-z0-9_-]{1,64})?\.json$/u.test(name)).sort().slice(0, MAX_CONNECTIONS);
    const connections: Connection[] = [];
    for (const name of names) {
      try {
        const bytes = await this.deps.files.readSecure(join(this.deps.stateDirectory, name), REGISTRATION_LIMIT, this.deps.currentUid);
        const registration = parseRegistration(bytes);
        if (!registration) continue;
        connections.push({
          connectionId: this.opaqueId(`local\0${registration.id ?? name}`),
          endpoint: registration.url,
          password: registration.password,
          version: registration.version,
          pid: registration.pid
        });
      } catch {
        // Unsafe and unreadable registrations are absent by design.
      }
    }
    return [...new Map(connections.map((connection) => [connection.connectionId, connection])).values()];
  }

  private async discoverSsh(): Promise<{ connections: Connection[]; failures: string[] }> {
    let servers: SshServer[];
    try {
      const bytes = await this.deps.files.readSecure(
        this.deps.settingsPath,
        SETTINGS_LIMIT,
        this.deps.currentUid,
        "owner-write"
      );
      servers = parseSshServers(bytes);
    } catch {
      return { connections: [], failures: [] };
    }
    const results = await mapConcurrent(servers, 2, async (server) => {
      const connectionId = this.opaqueId(`ssh\0${server.id}`);
      const existing = this.tunnels.get(connectionId);
      if (existing) return { connection: existing };
      try {
        const connection = await this.openSsh(server, connectionId);
        if (!this.running) {
          if (connection.tunnel) await this.terminateChild(connection.tunnel);
          return { failure: connectionId };
        }
        this.tunnels.set(connectionId, connection);
        return { connection };
      } catch {
        return { failure: connectionId };
      }
    });
    return {
      connections: results.flatMap((result) => result.connection ? [result.connection] : []),
      failures: results.flatMap((result) => result.failure ? [result.failure] : [])
    };
  }

  private async openSsh(server: SshServer, connectionId: string): Promise<Connection> {
    const target = parseSshTarget(server.target);
    const common = sshCommonArgs(target.args);
    const discovery = await this.deps.spawn(SSH_EXECUTABLE, [...common, target.host, "sh -l -s"], {
      env: minimalSshEnvironment(this.deps.homeDirectory), detached: true
    });
    this.children.add(discovery);
    discovery.write(REMOTE_DISCOVERY_SCRIPT);
    discovery.end();
    let timeoutHandle: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => reject(new Error("ssh-timeout")), FETCH_TIMEOUT_MS);
    });
    let output: string;
    let code: number | null;
    try {
      [output, , code] = await Promise.race([
        Promise.all([
          readProcessOutput(discovery.stdout, PROCESS_OUTPUT_LIMIT),
          readProcessOutput(discovery.stderr, 16 * 1024),
          discovery.exited
        ]),
        timeout
      ]);
    } catch (error) {
      await this.deps.terminateProcessGroup(discovery);
      throw error;
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      this.children.delete(discovery);
    }
    if (code !== 0) throw new Error("ssh-discovery");
    const registration = parseRemoteRegistration(output);
    if (!registration) throw new Error("ssh-registration");
    const remote = loopbackAddress(registration.url, true);
    const localPort = await this.deps.reserveLoopbackPort();
    const forward = `127.0.0.1:${localPort}:${remote.host}:${remote.port}`;
    const tunnel = await this.deps.spawn(SSH_EXECUTABLE, [
      ...common,
      "-o", "ExitOnForwardFailure=yes",
      "-o", "ControlMaster=no",
      "-o", "ControlPath=none",
      "-L", forward,
      "-N", target.host
    ], { env: minimalSshEnvironment(this.deps.homeDirectory), detached: true });
    this.children.add(tunnel);
    try {
      if (!await this.deps.waitForLoopbackPort(localPort, FETCH_TIMEOUT_MS)) throw new Error("ssh-forward");
      const endpoint = `http://127.0.0.1:${localPort}`;
      const unauthenticated = await this.fetchResponse(endpoint, "/api/status", undefined, 16 * 1024);
      if (unauthenticated.status !== 401 && unauthenticated.status !== 403) throw new Error("ssh-auth-boundary");
      return {
        connectionId,
        endpoint,
        password: registration.password,
        version: registration.version,
        pid: registration.pid,
        authenticationProbed: true,
        tunnel
      };
    } catch (error) {
      await this.terminateChild(tunnel);
      throw error;
    }
  }

  private async collectConnection(connection: Connection, now: number): Promise<OpenCodeConnectionSnapshot> {
    if (!connection.authenticationProbed) {
      const unauthenticated = await this.fetchResponse(connection.endpoint, "/api/status", undefined, 16 * 1024);
      if (unauthenticated.status !== 401 && unauthenticated.status !== 403) {
        return { ...unavailable(connection.connectionId, now), health: "incompatible" };
      }
      connection.authenticationProbed = true;
    }
    const status = await this.fetchJson(connection, "/api/status", 16 * 1024);
    if (!isRecord(status) || status.version !== connection.version || status.pid !== connection.pid) {
      return { ...unavailable(connection.connectionId, now), health: "incompatible" };
    }
    const [activeRaw, permissionRaw, formRaw, rootsRaw] = await Promise.all([
      this.fetchJson(connection, "/api/session/active"),
      this.fetchJson(connection, "/api/permission/request"),
      this.fetchJson(connection, "/api/form"),
      this.fetchJson(connection, "/api/session?parentID=null&order=desc&limit=100")
    ]);
    const activeIds = parseActive(activeRaw);
    const attentionIds = [...parsePending(permissionRaw), ...parsePending(formRaw)];
    const rootPage = parseRootSessions(rootsRaw);
    const roots = rootPage.sessions;
    const sessions = new Map(roots.map((session) => [session.id, session]));
    let complete = rootPage.complete;
    const requested = [...new Set([...activeIds, ...attentionIds])];
    const lineages = new Map<string, RawSession[]>();
    await mapConcurrent(requested, 4, async (id) => {
      const lineage: RawSession[] = [];
      let currentId: string | undefined = id;
      const seen = new Set<string>();
      for (let depth = 0; currentId && depth < MAX_ANCESTOR_DEPTH; depth++) {
        if (seen.has(currentId)) throw new Error("session-cycle");
        seen.add(currentId);
        let current = sessions.get(currentId);
        if (!current) {
          if (sessions.size >= MAX_SESSIONS) { complete = false; break; }
          current = parseSessionEnvelope(await this.fetchJson(connection, `/api/session/${encodeURIComponent(currentId)}`));
          if (sessions.size >= MAX_SESSIONS) { complete = false; break; }
          sessions.set(current.id, current);
        }
        lineage.push(current);
        currentId = current.parentID;
        if (depth === MAX_ANCESTOR_DEPTH - 1 && currentId) complete = false;
      }
      lineages.set(id, lineage);
    });
    const attentionRoots = new Set<string>();
    for (const id of attentionIds) {
      const lineage = lineages.get(id);
      const root = lineage?.[lineage.length - 1];
      if (root?.parentID !== undefined) continue;
      if (root) attentionRoots.add(root.id);
    }
    const activeRoots = new Set<string>();
    for (const id of activeIds) {
      const session = sessions.get(id);
      if (session && session.parentID === undefined) activeRoots.add(id);
    }
    const rootSessions = [...sessions.values()].filter((session) => session.parentID === undefined);
    const candidates: OpenCodeTask[] = [];
    for (const root of rootSessions) {
      const identity = taskIdentity(connection.connectionId, root.id);
      let task: Omit<OpenCodeTask, "label"> | undefined;
      if (attentionRoots.has(root.id)) {
        task = { source: "opencode", connectionId: connection.connectionId, sessionId: root.id, status: "attention" };
      } else if (activeRoots.has(root.id)) {
        task = {
          source: "opencode", connectionId: connection.connectionId, sessionId: root.id, status: "working",
          workStartedAt: normalizeTime(root.time.created, now),
          workStartRevision: 0
        };
      } else if (root.outcome === "succeeded" || root.outcome === "failed") {
        const sourceAt = root.time.idle ?? root.time.updated;
        if (root.time.viewed !== undefined && root.time.viewed >= sourceAt) continue;
        let binding = this.terminalBindings.get(identity);
        if (!binding || binding.sourceAt !== sourceAt) {
          binding = { sourceAt, localAt: normalizeTime(sourceAt, now), lastSeenAt: now, acknowledged: false };
          this.terminalBindings.set(identity, binding);
        } else binding.lastSeenAt = now;
        if (binding.acknowledged) continue;
        if (now - binding.localAt >= TERMINAL_RETENTION_MS) continue;
        task = {
          source: "opencode", connectionId: connection.connectionId, sessionId: root.id,
          status: root.outcome === "failed" ? "error" : "complete",
          terminalAt: binding.localAt,
          viewedAt: root.time.viewed === undefined ? undefined : normalizeTime(root.time.viewed, now)
        };
      }
      if (!task) continue;
      if (root.displayTitle) task.displayTitle = root.displayTitle;
      candidates.push({ ...task, label: "" });
    }
    candidates.sort(compareTasks);
    if (candidates.length > MAX_ROOTS) complete = false;
    return {
      connectionId: connection.connectionId,
      health: complete ? "ready" : "capacity-exceeded",
      complete,
      observedAt: now,
      tasks: candidates.slice(0, MAX_ROOTS)
    };
  }

  private async fetchJson(connection: Connection, path: string, maximumBytes = RESPONSE_LIMIT): Promise<unknown> {
    const auth = `Basic ${Buffer.from(`opencode:${connection.password}`).toString("base64")}`;
    const result = await this.fetchResponse(connection.endpoint, path, auth, maximumBytes);
    if (result.status < 200 || result.status >= 300) throw new Error("http-status");
    try { return JSON.parse(result.body); } catch { throw new Error("invalid-json"); }
  }

  private async fetchResponse(endpoint: string, path: string, authorization?: string, maximumBytes = RESPONSE_LIMIT) {
    const controller = new AbortController();
    this.abortControllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await this.deps.fetch(new URL(path, endpoint).toString(), {
        method: "GET",
        headers: authorization ? { authorization } : undefined,
        redirect: "error",
        signal: controller.signal
      });
      return { status: response.status, body: await readBoundedBody(response, maximumBytes) };
    } finally {
      clearTimeout(timeout);
      this.abortControllers.delete(controller);
    }
  }

  private opaqueId(value: string): string {
    return `oc_${createHmac("sha256", this.secret).update(value).digest("base64url")}`;
  }

  private pruneTerminalBindings(): void {
    const maximumBindings = MAX_CONNECTIONS * MAX_SESSIONS;
    if (this.terminalBindings.size <= maximumBindings) return;
    const oldest = [...this.terminalBindings.entries()]
      .sort((left, right) => left[1].lastSeenAt - right[1].lastSeenAt || left[0].localeCompare(right[0]));
    for (const [identity] of oldest.slice(0, this.terminalBindings.size - maximumBindings)) {
      this.terminalBindings.delete(identity);
    }
  }

  private pruneLabels(): void {
    const maximumLabels = MAX_CONNECTIONS * MAX_SESSIONS;
    if (this.labels.size <= maximumLabels) return;
    const oldest = [...this.labels.entries()]
      .sort((left, right) => left[1].lastSeenAt - right[1].lastSeenAt || left[0].localeCompare(right[0]));
    for (const [identity] of oldest.slice(0, this.labels.size - maximumLabels)) this.labels.delete(identity);
  }

  private async terminateChild(child: OpenCodeProcess): Promise<void> {
    if (!this.children.delete(child)) return;
    await this.deps.terminateProcessGroup(child);
  }

  private async terminateChildren(): Promise<void> {
    const children = [...this.children];
    this.children.clear();
    await Promise.allSettled(children.map((child) => this.deps.terminateProcessGroup(child)));
  }
}

function unavailable(connectionId: string, observedAt: number): OpenCodeConnectionSnapshot {
  return { connectionId, health: "unavailable", complete: false, observedAt, tasks: [] };
}

function taskIdentity(connectionId: string, sessionId: string): string {
  return `${connectionId}\0${sessionId}`;
}

function parseRegistration(bytes: Buffer, remote = false): Registration | null {
  let value: unknown;
  try { value = JSON.parse(bytes.toString("utf8")); } catch { return null; }
  if (!isRecord(value) || (value.id !== undefined && !boundedString(value.id, 256)) ||
    !boundedString(value.url, 2048) || !boundedString(value.password, 1024) || value.password.length === 0 ||
    !boundedString(value.version, 64) || value.version.length === 0 || /[\u0000-\u001f\u007f]/u.test(value.version) ||
    !positiveInteger(value.pid)) return null;
  try { loopbackAddress(value.url, remote); } catch { return null; }
  return { id: value.id as string | undefined, url: value.url, password: value.password, version: value.version, pid: value.pid };
}

function parseRemoteRegistration(output: string): Registration | null {
  const status = output.split(/\r?\n/u)
    .find((line) => line.startsWith("OPENCODE_SERVICE_STATUS="))
    ?.slice("OPENCODE_SERVICE_STATUS=".length);
  if (!status || status === "stopped") return null;
  const expression = /OPENCODE_REGISTRATION_BEGIN\r?\n([\s\S]*?)\r?\nOPENCODE_REGISTRATION_END/gu;
  for (const match of output.matchAll(expression)) {
    const parsed = parseRegistration(Buffer.from(match[1] ?? ""), true);
    if (parsed?.url === status) return parsed;
  }
  const pairOutput = remoteBlock(output, "OPENCODE_PAIR", 32 * 1024);
  const pairStatus = remoteBlock(output, "OPENCODE_PAIR_STATUS", 65_536);
  if (!pairOutput || !pairStatus) return null;
  const cleanPairOutput = pairOutput.replace(/\u001b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/gu, "");
  const pairPassword = cleanPairOutput.match(/^\s*Password\s+([A-Za-z0-9._~+/=-]{1,1024})\s*$/mu)?.[1];
  if (!pairPassword) return null;
  let identity: unknown;
  try { identity = JSON.parse(pairStatus); } catch { return null; }
  if (!isRecord(identity) || !boundedString(identity.version, 64) || identity.version.length === 0 ||
    !positiveInteger(identity.pid)) return null;
  return parseRegistration(Buffer.from(JSON.stringify({
    url: status,
    password: pairPassword,
    version: identity.version,
    pid: identity.pid
  })), true);
}

function remoteBlock(output: string, name: string, maximumBytes: number): string | null {
  const normalized = output.replace(/\r\n/gu, "\n");
  const opening = `${name}_BEGIN\n`;
  const closing = `\n${name}_END`;
  const start = normalized.indexOf(opening);
  if (start < 0 || normalized.indexOf(opening, start + opening.length) >= 0) return null;
  const contentStart = start + opening.length;
  const end = normalized.indexOf(closing, contentStart);
  if (end < 0 || normalized.indexOf(closing, end + closing.length) >= 0) return null;
  const content = normalized.slice(contentStart, end);
  return Buffer.byteLength(content, "utf8") <= maximumBytes ? content : null;
}

function parseSshServers(bytes: Buffer): SshServer[] {
  const value = JSON.parse(bytes.toString("utf8")) as unknown;
  if (!isRecord(value)) throw new Error("settings-shape");
  const raw = value["ssh.servers"];
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > MAX_SSH_SERVERS) throw new Error("ssh-shape");
  return raw.map((item) => {
    if (!isRecord(item) || !boundedString(item.id, 256) || !boundedString(item.target, 2048) ||
      !boundedString(item.name, 256) || item.id.length === 0 || item.target.length === 0) throw new Error("ssh-entry");
    return { id: item.id, target: item.target, name: item.name };
  });
}

function loopbackAddress(input: string, remote = false): { host: string; port: number } {
  const url = new URL(input);
  const allowedHosts = remote
    ? new Set(["127.0.0.1", "localhost", "0.0.0.0", "[::]", "[::1]"])
    : new Set(["127.0.0.1", "[::1]"]);
  if (url.protocol !== "http:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash ||
    !allowedHosts.has(url.hostname) || !url.port) throw new Error("origin");
  const port = Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("port");
  return { host: url.hostname === "[::]" || url.hostname === "[::1]" ? "[::1]" : "127.0.0.1", port };
}

function parseActive(value: unknown): string[] {
  if (!isRecord(value) || !isRecord(value.data)) throw new Error("active-shape");
  const entries = Object.entries(value.data);
  if (entries.length > MAX_SESSIONS) throw new Error("active-capacity");
  return entries.map(([id, state]) => {
    if (!validId(id) || !isRecord(state) || state.type !== "running") throw new Error("active-entry");
    return id;
  });
}

function parsePending(value: unknown): string[] {
  if (!isRecord(value) || !Array.isArray(value.data) || value.data.length > MAX_SESSIONS) throw new Error("pending-shape");
  return value.data.map((item) => {
    if (!isRecord(item) || !validId(item.sessionID)) throw new Error("pending-entry");
    return item.sessionID;
  });
}

function parseRootSessions(value: unknown): { sessions: RawSession[]; complete: boolean } {
  if (!isRecord(value) || !Array.isArray(value.data) || value.data.length > MAX_ROOTS || !isRecord(value.cursor)) {
    throw new Error("root-shape");
  }
  if ((value.cursor.next !== undefined && !boundedString(value.cursor.next, 4096)) ||
    (value.cursor.previous !== undefined && !boundedString(value.cursor.previous, 4096))) throw new Error("cursor-shape");
  const sessions = value.data.map(parseSession);
  if (sessions.some((session) => session.parentID !== undefined)) throw new Error("non-root");
  return {
    sessions: [...new Map(sessions.map((session) => [session.id, session])).values()],
    complete: value.cursor.next === undefined
  };
}

function parseSessionEnvelope(value: unknown): RawSession {
  if (!isRecord(value)) throw new Error("session-envelope");
  return parseSession(value.data);
}

function parseSession(value: unknown): RawSession {
  if (!isRecord(value) || !validId(value.id) || (value.parentID !== undefined && !validId(value.parentID)) ||
    !isRecord(value.time) || !timestamp(value.time.created) || !timestamp(value.time.updated) ||
    (value.time.idle !== undefined && !timestamp(value.time.idle)) ||
    (value.time.viewed !== undefined && !timestamp(value.time.viewed)) ||
    (value.outcome !== undefined && !["succeeded", "failed", "interrupted"].includes(String(value.outcome)))) {
    throw new Error("session-shape");
  }
  return {
    id: value.id,
    parentID: value.parentID as string | undefined,
    displayTitle: sanitizeDisplayTitle(value.title),
    outcome: value.outcome as RawSession["outcome"],
    time: {
      created: value.time.created,
      updated: value.time.updated,
      idle: value.time.idle as number | undefined,
      viewed: value.time.viewed as number | undefined
    }
  };
}

function sanitizeDisplayTitle(value: unknown): string | undefined {
  if (typeof value !== "string") return;
  const cleaned = value
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (!cleaned) return;
  const characters: string[] = [];
  let bytes = 0;
  for (const character of cleaned) {
    const size = Buffer.byteLength(character, "utf8");
    if (characters.length >= 120 || bytes + size > 256) break;
    characters.push(character);
    bytes += size;
  }
  return characters.join("") || undefined;
}

async function readBoundedBody(response: Response, maximumBytes: number): Promise<string> {
  const length = response.headers.get("content-length");
  if (length !== null && (!/^\d+$/u.test(length) || Number(length) > maximumBytes)) throw new Error("response-size");
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maximumBytes) throw new Error("response-size");
      chunks.push(next.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

async function mapConcurrent<T, R>(values: readonly T[], concurrency: number, operation: (value: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (true) {
      const index = next++;
      const value = values[index];
      if (value === undefined) return;
      results[index] = await operation(value);
    }
  }));
  return results;
}

function compareTasks(left: OpenCodeTask, right: OpenCodeTask): number {
  const priority: Record<OpenCodeTaskStatus, number> = { attention: 0, error: 1, complete: 2, working: 3 };
  return priority[left.status] - priority[right.status] || left.sessionId.localeCompare(right.sessionId);
}

function normalizeTime(value: number, now: number): number {
  return Math.min(value, now);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, maximum: number): value is string {
  return typeof value === "string" && Buffer.byteLength(value, "utf8") <= maximum;
}

function validId(value: unknown): value is string {
  return typeof value === "string" && ID_PATTERN.test(value);
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function timestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function parseSshTarget(input: string): { host: string; args: string[] } {
  if (!boundedString(input, 2048) || /[\r\n\0]/u.test(input)) throw new Error("ssh-target");
  const tokens = tokenize(input);
  if (tokens[0] === "ssh") tokens.shift();
  const args: string[] = [];
  const options = new Set(["hostname", "user", "port", "identityfile", "identityagent", "identitiesonly", "proxyjump", "proxycommand", "connecttimeout", "addressfamily"]);
  while (tokens[0]?.startsWith("-")) {
    const token = tokens.shift()!;
    if (["-4", "-6", "-C", "-a"].includes(token)) { args.push(token); continue; }
    const flag = token.slice(0, 2);
    if (!["-p", "-l", "-i", "-F", "-J", "-o"].includes(flag)) throw new Error("ssh-option");
    const value = token.length > 2 ? token.slice(2) : tokens.shift();
    if (!value || value.startsWith("-") || value.length > 1024) throw new Error("ssh-option");
    if (flag === "-p" && (!/^\d+$/u.test(value) || Number(value) < 1 || Number(value) > 65535)) throw new Error("ssh-port");
    if (flag === "-o" && !options.has((value.split(/[=\s]/u)[0] ?? "").toLowerCase())) throw new Error("ssh-option");
    args.push(flag, value);
  }
  const host = tokens[0];
  if (tokens.length !== 1 || !host || !/^[A-Za-z0-9_@.:[\]%-]{1,512}$/u.test(host) || host.startsWith("-")) throw new Error("ssh-host");
  if (host.includes("@") && host.slice(0, host.lastIndexOf("@")).includes(":")) throw new Error("ssh-host");
  if (args.length > 32) throw new Error("ssh-args");
  return { host, args };
}

function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let word = "";
  let quote = "";
  let started = false;
  for (let index = 0; index < input.length; index++) {
    const character = input[index]!;
    if (character === "\\" && quote !== "'" && index + 1 < input.length && /[\s\\"']/u.test(input[index + 1]!)) {
      word += input[++index]; started = true; continue;
    }
    if (quote) { if (character === quote) quote = ""; else word += character; continue; }
    if (character === "'" || character === "\"") { quote = character; started = true; continue; }
    if (/\s/u.test(character)) { if (started) tokens.push(word); word = ""; started = false; continue; }
    word += character; started = true;
  }
  if (quote) throw new Error("ssh-quote");
  if (started) tokens.push(word);
  return tokens;
}

function sshCommonArgs(userArgs: string[]): string[] {
  return [
    "-T", ...userArgs,
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=5",
    "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=2",
    "-o", "RemoteCommand=none",
    "-o", "RequestTTY=no",
    "-o", "PermitLocalCommand=no"
  ];
}

function minimalSshEnvironment(home: string): NodeJS.ProcessEnv {
  return {
    HOME: home,
    PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
    SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK,
    LANG: process.env.LANG ?? "C",
    LC_ALL: "C"
  };
}

async function readProcessOutput(source: OpenCodeProcess["stdout"], maximum: number): Promise<string> {
  if (typeof source === "string") {
    if (Buffer.byteLength(source) > maximum) throw new Error("process-output");
    return source;
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of source) {
    const buffer = Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > maximum) throw new Error("process-output");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

async function spawnProcess(command: string, args: string[], options: { env: NodeJS.ProcessEnv; detached: boolean }): Promise<OpenCodeProcess> {
  const child = nodeSpawn(command, args, {
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    env: options.env,
    detached: options.detached,
    windowsHide: true
  }) as ChildProcessWithoutNullStreams;
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  return {
    pid: child.pid!,
    stdout: child.stdout,
    stderr: child.stderr,
    exited: new Promise((resolve) => child.once("close", resolve)),
    write: (data) => { child.stdin.write(data); },
    end: () => { child.stdin.end(); },
    kill: (signal) => { child.kill(signal); }
  };
}

async function reserveLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForLoopbackPort(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ready = await new Promise<boolean>((resolve) => {
      const socket = connect({ host: "127.0.0.1", port });
      socket.setTimeout(100);
      socket.once("connect", () => { socket.destroy(); resolve(true); });
      socket.once("error", () => resolve(false));
      socket.once("timeout", () => { socket.destroy(); resolve(false); });
    });
    if (ready) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

async function terminateProcessGroup(child: OpenCodeProcess): Promise<void> {
  try {
    if (process.platform !== "win32") process.kill(-child.pid, "SIGTERM");
    else child.kill("SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  await Promise.race([child.exited, new Promise((resolve) => setTimeout(resolve, 500))]);
  try {
    if (process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
    else child.kill("SIGKILL");
  } catch {
    // The process group already exited.
  }
}
