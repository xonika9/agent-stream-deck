import type {
  RawSession,
  OpenCodeTask,
  OpenCodeConnectionSnapshot,
  OpenCodeCollectorSnapshot,
  LabelBinding,
  TerminalBinding,
} from "./contracts.js";
import { TERMINAL_RETENTION_WINDOW_MS, MAX_CONNECTIONS, MAX_SESSIONS, MAX_ROOTS } from "./limits.js";
import { taskIdentity, compareTasks, normalizeTime } from "./collection-utils.js";

export class OpenCodeTaskState {
  private readonly labels = new Map<string, LabelBinding>();
  private readonly terminalBindings = new Map<string, TerminalBinding>();
  private nextLabel = 1;

  acknowledgedRevision(connectionId: string, sessionId: string): TerminalBinding | undefined {
    return this.terminalBindings.get(taskIdentity(connectionId, sessionId));
  }

  acknowledgeTask(
    current: OpenCodeCollectorSnapshot,
    connectionId: string,
    sessionId: string,
    terminalAt: number,
  ): OpenCodeCollectorSnapshot | undefined {
    const task = current.connections
      .flatMap((connection) => connection.tasks)
      .find(
        (candidate) =>
          candidate.connectionId === connectionId &&
          candidate.sessionId === sessionId &&
          (candidate.status === "complete" || candidate.status === "error"),
      );
    if (!task) return;
    const binding = this.terminalBindings.get(taskIdentity(connectionId, sessionId));
    if (!binding || binding.localAt !== terminalAt || binding.acknowledged) return;
    binding.acknowledged = true;
    return {
      ...current,
      connections: current.connections.map((connection) => ({
        ...connection,
        tasks: connection.tasks.filter(
          (candidate) => candidate.connectionId !== connectionId || candidate.sessionId !== sessionId,
        ),
      })),
    };
  }
  label(connections: OpenCodeConnectionSnapshot[], now: number): void {
    for (const connection of connections) {
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
  }

  project(
    connectionId: string,
    rootSessions: RawSession[],
    attentionRoots: Set<string>,
    activeRoots: Set<string>,
    now: number,
    complete: boolean,
  ): OpenCodeConnectionSnapshot {
    const candidates: OpenCodeTask[] = [];
    for (const root of rootSessions) {
      const identity = taskIdentity(connectionId, root.id);
      let task: Omit<OpenCodeTask, "label"> | undefined;
      if (attentionRoots.has(root.id)) {
        task = { source: "opencode", connectionId: connectionId, sessionId: root.id, status: "attention" };
      } else if (activeRoots.has(root.id)) {
        task = {
          source: "opencode",
          connectionId: connectionId,
          sessionId: root.id,
          status: "working",
          workStartedAt: normalizeTime(root.time.created, now),
          workStartRevision: 0,
        };
      } else if (root.outcome === "succeeded" || root.outcome === "failed") {
        const sourceAt = root.time.idle ?? root.time.updated;
        if (root.time.viewed !== undefined && root.time.viewed >= sourceAt) continue;
        let binding = this.terminalBindings.get(identity);
        if (!binding || binding.sourceAt !== sourceAt) {
          const localAt = normalizeTime(sourceAt, now);
          binding = {
            sourceAt,
            idleAt: root.time.idle,
            localAt,
            lastSeenAt: now,
            acknowledged: now - localAt >= TERMINAL_RETENTION_WINDOW_MS,
          };
          this.terminalBindings.set(identity, binding);
        } else {
          binding.lastSeenAt = now;
          if (root.time.idle !== undefined) binding.idleAt = root.time.idle;
        }
        if (now - binding.localAt >= TERMINAL_RETENTION_WINDOW_MS) binding.acknowledged = true;
        if (binding.acknowledged) continue;
        task = {
          source: "opencode",
          connectionId: connectionId,
          sessionId: root.id,
          status: root.outcome === "failed" ? "error" : "complete",
          terminalAt: binding.localAt,
          viewedAt: root.time.viewed === undefined ? undefined : normalizeTime(root.time.viewed, now),
        };
      }
      if (!task) continue;
      if (root.displayTitle) task.displayTitle = root.displayTitle;
      candidates.push({ ...task, label: "" });
    }
    candidates.sort(compareTasks);
    if (candidates.length > MAX_ROOTS) complete = false;
    return {
      connectionId: connectionId,
      health: complete ? "ready" : "capacity-exceeded",
      complete,
      observedAt: now,
      tasks: candidates.slice(0, MAX_ROOTS),
    };
  }

  private pruneTerminalBindings(): void {
    const maximumBindings = MAX_CONNECTIONS * MAX_SESSIONS;
    if (this.terminalBindings.size <= maximumBindings) return;
    const oldest = [...this.terminalBindings.entries()].sort(
      (left, right) => left[1].lastSeenAt - right[1].lastSeenAt || left[0].localeCompare(right[0]),
    );
    for (const [identity] of oldest.slice(0, this.terminalBindings.size - maximumBindings)) {
      this.terminalBindings.delete(identity);
    }
  }

  private pruneLabels(): void {
    const maximumLabels = MAX_CONNECTIONS * MAX_SESSIONS;
    if (this.labels.size <= maximumLabels) return;
    const oldest = [...this.labels.entries()].sort(
      (left, right) => left[1].lastSeenAt - right[1].lastSeenAt || left[0].localeCompare(right[0]),
    );
    for (const [identity] of oldest.slice(0, this.labels.size - maximumLabels)) this.labels.delete(identity);
  }
}
