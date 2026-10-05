import type { CodexHost, HostHealth, RoutedAgentSlot, TaskSource } from "#agents";
import { shouldCollectOpenCode } from "#agents";
import { taskIdentity } from "./collection-utils.js";
import { foregroundOpenCode } from "./open.js";
import { getOrCreateOpenCodeIdentitySecret } from "./secret.js";
import { OpenCodeCollector, type OpenCodeCollectorSnapshot, type OpenCodeTask } from "./collector.js";

export class OpenCodeSource {
  openCodeSlots: RoutedAgentSlot[] = [];
  openCodeHealth: HostHealth = { state: "connecting", reason: "awaiting-snapshot", changedAt: Date.now() };
  openCodeCollector?: OpenCodeCollector;
  private openCodeDemandGeneration = 0;
  private localHost?: CodexHost;
  private demanded = false;

  constructor(private readonly log: (message: string) => void, private readonly foreground = foregroundOpenCode) {}

  stop(): void {
    this.demanded = false;
    this.openCodeDemandGeneration++;
    const collector = this.openCodeCollector;
    this.openCodeCollector = undefined;
    void collector?.stop();
  }

  async open(assignment: RoutedAgentSlot, signal: AbortSignal): Promise<boolean> {
    const collector = this.openCodeCollector;
    const generation = this.openCodeDemandGeneration;
    await this.foreground();
    if (signal.aborted || generation !== this.openCodeDemandGeneration || collector !== this.openCodeCollector) return false;
    const separator = assignment.threadKey?.indexOf("\0") ?? -1;
    if (!collector || separator <= 0 || !assignment.threadKey || assignment.activityAt === undefined) return false;
    const connectionId = assignment.threadKey.slice(0, separator);
    const sessionId = assignment.threadKey.slice(separator + 1);
    if (!collector.acknowledgeTask(connectionId, sessionId, assignment.activityAt)) return false;
    void collector.publishTaskViewed(connectionId, sessionId).catch(() => undefined);
    return true;
  }

  async syncDemand(taskSource: TaskSource, host: CodexHost | undefined, stopped: boolean): Promise<void> {
    this.demanded = !stopped && shouldCollectOpenCode(taskSource, process.platform);
    this.localHost = host;
    const demanded = this.demanded;
    if (demanded && this.openCodeCollector) return;
    const generation = ++this.openCodeDemandGeneration;
    if (!demanded) {
      const collector = this.openCodeCollector;
      this.openCodeCollector = undefined;
      this.openCodeSlots = [];
      this.openCodeHealth = { state: "connecting", reason: "awaiting-snapshot", changedAt: Date.now() };
      await collector?.stop();
      return;
    }
    this.openCodeHealth = { state: "connecting", reason: "awaiting-snapshot", changedAt: Date.now() };
    try {
      const secret = await getOrCreateOpenCodeIdentitySecret();
      if (generation !== this.openCodeDemandGeneration || !this.demanded) return;
      const collector = new OpenCodeCollector({ identitySecret: secret });
      this.openCodeCollector = collector;
      const snapshot = await collector.start();
      if (generation !== this.openCodeDemandGeneration || !this.demanded) {
        if (this.openCodeCollector === collector) this.openCodeCollector = undefined;
        await collector.stop();
        return;
      }
      this.applyOpenCodeSnapshot(snapshot);
    } catch {
      if (generation !== this.openCodeDemandGeneration) return;
      const collector = this.openCodeCollector;
      this.openCodeCollector = undefined;
      await collector?.stop();
      this.openCodeSlots = [];
      this.openCodeHealth = { state: "degraded", reason: "native-signals-unavailable", changedAt: Date.now() };
      this.log("OpenCode collector is unavailable.");
    }
  }

  refreshOpenCodeSnapshot(): void {
    const collector = this.openCodeCollector;
    if (!collector) return;
    this.applyOpenCodeSnapshot(collector.snapshot());
  }

  private applyOpenCodeSnapshot(snapshot: OpenCodeCollectorSnapshot): void {
    if (!this.localHost) return;
    const healthy = snapshot.connections.some((connection) => connection.health === "ready" || connection.health === "capacity-exceeded");
    const observedAt = snapshot.observedAt || Date.now();
    this.openCodeHealth = healthy
      ? { state: "ready", changedAt: observedAt }
      : { state: "degraded", reason: "native-signals-unavailable", changedAt: observedAt };
    this.openCodeSlots = snapshot.connections
      .flatMap((connection) => connection.tasks.map((task) => ({ task, observedAt: connection.observedAt })))
      .map(({ task, observedAt: connectionObservedAt }, sourceSlot) =>
        openCodeTaskSlot(task, sourceSlot, connectionObservedAt, this.localHost!));
  }



}

export function openCodeTaskSlot(task: OpenCodeTask, sourceSlot: number, observedAt: number, host: CodexHost): RoutedAgentSlot {
    const identity = taskIdentity(task.connectionId, task.sessionId);
    return {
      id: sourceSlot,
      sourceSlot,
      catalogIndex: sourceSlot,
      taskSource: "opencode",
      host,
      threadKey: identity,
      conversationId: identity,
      title: task.displayTitle ?? task.label,
      status: task.status,
      selected: false,
      activityAt: task.terminalAt ?? task.workStartedAt,
      workStartedAt: task.workStartedAt,
      workStartRevision: task.workStartRevision,
      observedAt
    };
  }
