import streamDeck, { type KeyAction } from "@elgato/streamdeck";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { codexDeckStateRoot } from "./codex-deck-paths.js";
import { ActiveQueueRankIndex, projectActiveQueue } from "./active-queue.js";
import {
  isRemoteControlRequest, readControlTarget, resolveStartupControlTarget, writeControlTarget,
  type HostPlatform as ControlTarget
} from "./control-target.js";
import { CodexRelayClient, readRelayClientConfig } from "./codex-relay-client.js";
import { CodexRelayServer, readRelayServerConfig } from "./codex-relay-server.js";
import { CodexMicroRendererBridge, localBridgeFailureReason } from "./codex-micro-renderer-bridge.js";
import { readCodexBarUsage } from "./codex-bar-usage.js";
import { getOrCreateHostIdentity } from "./host-identity.js";
import type { OfficialKeycapId } from "./keycaps.js";
import { HostActivityIndex, type HostSnapshot, type RelayCommand } from "./relay-protocol.js";
import {
  renderAgentBlackKey, renderAgentKey, renderBuiltinKeycap, renderFallbackKeycap, renderHostTargetKey, renderImportedKeycap,
  renderRateLimitResetKey, renderUsageLimitKey, renderUsageOverviewKey, type BuiltinIconName
} from "./render.js";
import { openCodexThread } from "./codex-open.js";
import { foregroundOpenCode } from "./opencode-open.js";
import { getOrCreateOpenCodeIdentitySecret } from "./opencode-secret.js";
import {
  OpenCodeCollector,
  type OpenCodeCollectorSnapshot,
  type OpenCodeTask
} from "./opencode/index.js";
import { visualStatusFromMicro } from "./status.js";
import { parseTaskSource, selectTaskCandidates, shouldCollectOpenCode, usesActiveQueue } from "./task-source.js";
import type {
  CodexHost, HostHealth, MicroActionSlot, MicroDirection, MicroSnapshot, ReasoningAdjustment,
  RoutedAgentSlot, TaskSource, UsageLimitMode, UsageSnapshot, UsageWindowKind
} from "./types.js";
import { composeMacUsage, selectAccountUsageSource, selectUsageWindow, usageTheme, type AccountUsageSource } from "./usage.js";

export type FixedIconSource =
  | { kind: "local"; keycapId: string }
  | { kind: "builtin"; name: BuiltinIconName };

type FixedIconRegistration = { action: KeyAction; source: FixedIconSource };
type AgentRegistration = { action: KeyAction; slot: number };
type MicroActionRegistration = { action: KeyAction; slot: MicroActionSlot };
type UsageLimitRegistration = { action: KeyAction; mode: UsageLimitMode };
type ActionIdentity = { id: string };
export type AgentDisplaySettings = {
  showContextRings?: boolean;
  activeQueueEnabled?: boolean;
  taskSource?: TaskSource;
};

type DeckControllerDependencies = {
  foregroundOpenCode: () => Promise<void>;
};

const USER_ICON_ROOT = join(codexDeckStateRoot(), "icons");
const LOCAL_MOBILE_CONFIG = "mobile-local-relay-server.json";
const RESET_HOLD_MS = 1_200;

export class DeckController {
  private readonly foregroundOpenCodeAction: () => Promise<void>;
  private readonly microBridge = new CodexMicroRendererBridge((message) => streamDeck.logger.info(message));
  private readonly agents = new Map<string, AgentRegistration>();
  private readonly microActions = new Map<string, MicroActionRegistration>();
  private readonly fixedActions = new Map<string, FixedIconRegistration>();
  private readonly keycapImages = new Map<string, Promise<string | null>>();
  private readonly lastImages = new Map<string, string>();
  private readonly hostToggleActions = new Map<string, KeyAction>();
  private readonly usageLimitActions = new Map<string, UsageLimitRegistration>();
  private readonly usageOverviewActions = new Map<string, KeyAction>();
  private readonly rateLimitResetActions = new Map<string, KeyAction>();
  private readonly resetHolds = new Map<string, number>();
  private readonly activityIndex = new HostActivityIndex();
  private readonly activeQueueRankIndex = new ActiveQueueRankIndex();
  private readonly pressedAgents = new Map<number, RoutedAgentSlot>();
  private readonly emptyAgentPresses = new Set<number>();
  private readonly pressedControlTargets = new Map<string, string>();
  private relayClient?: CodexRelayClient;
  private mobileRelayServer?: CodexRelayServer;
  private localMobileRelayServer?: CodexRelayServer;
  private localHost?: CodexHost;
  private localSnapshot?: HostSnapshot;
  private codexBarUsage?: UsageSnapshot;
  private openCodeSlots: RoutedAgentSlot[] = [];
  private openCodeHealth: HostHealth = { state: "connecting", reason: "awaiting-snapshot", changedAt: Date.now() };
  private openCodeCollector?: OpenCodeCollector;
  private openCodeDemandGeneration = 0;
  private routedSlots: RoutedAgentSlot[] = [];
  private targetHostId?: string;
  private targetPlatform: ControlTarget = "win32";
  private localHealth: HostHealth = { state: "connecting", reason: "awaiting-snapshot", changedAt: Date.now() };
  private poll?: NodeJS.Timeout;
  private animation?: NodeJS.Timeout;
  private refreshInFlight?: Promise<void>;
  private stopped = false;
  private animationFrame = 0;
  private lastError = "";
  private lastAssignmentSignature = "";
  private lastStatusSignature = "";
  private lastLayoutSignature = "";
  private lastAgentSourceSignature = "";
  private lastHostHealthSignature = "";
  private showContextRings = true;
  private activeQueueEnabled = false;
  private taskSource: TaskSource = "Codex";

  constructor(dependencies: Partial<DeckControllerDependencies> = {}) {
    this.foregroundOpenCodeAction = dependencies.foregroundOpenCode ?? foregroundOpenCode;
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.loadAgentDisplaySettings();
    this.localHost = await getOrCreateHostIdentity();
    const persistedTarget = await readControlTarget(undefined, this.localHost.platform);
    const relayConfig = await readRelayClientConfig();
    this.targetPlatform = resolveStartupControlTarget(
      persistedTarget, this.localHost.platform, relayConfig != null);
    if (this.targetPlatform !== persistedTarget) await writeControlTarget(this.targetPlatform);
    if (this.targetPlatform === this.localHost.platform) this.targetHostId = this.localHost.hostId;
    await this.syncOpenCodeCollectorDemand();
    if (relayConfig) {
      this.relayClient = new CodexRelayClient(
        relayConfig,
        () => { void this.refreshDisplay(); },
        (message) => streamDeck.logger.info(message)
      );
      this.relayClient.start();
    }
    try {
      const [mobileRelayConfig, localMobileRelayConfig] = await Promise.all([
        readRelayServerConfig(join(codexDeckStateRoot(), "mobile-relay-server.json")),
        readRelayServerConfig(join(codexDeckStateRoot(), LOCAL_MOBILE_CONFIG))
      ]);
      if (mobileRelayConfig || localMobileRelayConfig) {
        let mobileSnapshotDirty = false;
        const runAndInvalidate = async (operation: () => Promise<void>): Promise<void> => {
          await operation();
          // The relay server publishes a fresh snapshot after acknowledging the
          // command. Do not make the command result wait for a second full
          // controller refresh: a renderer refresh can take several seconds
          // and remote clients intentionally use a short command timeout.
          mobileSnapshotDirty = true;
        };
        const mobileControl = {
          refresh: async () => {
            if (!mobileSnapshotDirty && this.localHealth.state === "ready" && this.localSnapshot && Date.now() - this.localSnapshot.observedAt < 1_800) {
              return this.localSnapshot.snapshot;
            }
            await this.refresh();
            if (this.localHealth.state !== "ready" || !this.localSnapshot) {
              throw new Error("Codex Micro snapshot is temporarily unavailable.");
            }
            mobileSnapshotDirty = false;
            return this.localSnapshot.snapshot;
          },
          sendAgent: (slot: number, act: 0 | 1, threadKey?: string) => runAndInvalidate(
            () => this.microBridge.sendAgent(slot, act, threadKey)),
          sendAction: (slot: MicroActionSlot, act: 0 | 1) => runAndInvalidate(
            () => this.microBridge.sendAction(slot, act)),
          sendJoystick: (direction: MicroDirection, distance: 0 | 1) => runAndInvalidate(
            () => this.microBridge.sendJoystick(direction, distance)),
          sendEncoder: (act: 0 | 1) => runAndInvalidate(() => this.microBridge.sendEncoder(act)),
          adjustReasoning: (direction: ReasoningAdjustment) => runAndInvalidate(
            () => this.microBridge.adjustReasoning(direction)),
          runKeycap: (keycapId: OfficialKeycapId) => runAndInvalidate(
            () => this.microBridge.runKeycap(keycapId)),
          consumeRateLimitReset: () => runAndInvalidate(() => this.microBridge.consumeRateLimitReset())
        };
        if (mobileRelayConfig) {
          this.mobileRelayServer = new CodexRelayServer(
            mobileRelayConfig, this.localHost, mobileControl,
            (message) => streamDeck.logger.info(`Mobile relay: ${message}`)
          );
          await this.mobileRelayServer.start();
        }
        if (localMobileRelayConfig) {
          this.localMobileRelayServer = new CodexRelayServer(
            localMobileRelayConfig, this.localHost, mobileControl,
            (message) => streamDeck.logger.info(`Nearby mobile relay: ${message}`)
          );
          await this.localMobileRelayServer.start();
        }
      }
    } catch (error) {
      this.mobileRelayServer = undefined;
      this.localMobileRelayServer = undefined;
      streamDeck.logger.error(`Optional mobile relay was not started: ${String(error)}`);
    }
    await this.refresh();
    this.scheduleRefresh();
    this.scheduleAnimation();
  }

  private async loadAgentDisplaySettings(): Promise<void> {
    try {
      const settings = await streamDeck.settings.getGlobalSettings<AgentDisplaySettings>();
      this.showContextRings = settings.showContextRings !== false;
      this.activeQueueEnabled = settings.activeQueueEnabled === true;
      this.taskSource = parseTaskSource(settings.taskSource);
    } catch (error) {
      streamDeck.logger.warn(`Agent display settings were unavailable; using defaults: ${String(error)}`);
    }
  }

  stop(): void {
    this.stopped = true;
    this.openCodeDemandGeneration++;
    if (this.poll) clearInterval(this.poll);
    if (this.animation) clearInterval(this.animation);
    this.relayClient?.close();
    void this.mobileRelayServer?.close();
    void this.localMobileRelayServer?.close();
    this.microBridge.close();
    const collector = this.openCodeCollector;
    this.openCodeCollector = undefined;
    void collector?.stop();
  }

  registerAgent(slot: number, action: KeyAction): void {
    this.agents.set(action.id, { action, slot });
    void this.renderAgent({ action, slot });
  }

  unregisterAgent(action: ActionIdentity): void {
    this.unregister(action, this.agents);
  }

  setAgentDisplaySettings(settings: AgentDisplaySettings): void {
    const showContextRings = settings.showContextRings !== false;
    const activeQueueEnabled = settings.activeQueueEnabled === true;
    const taskSource = parseTaskSource(settings.taskSource);
    const contextRingsChanged = this.showContextRings !== showContextRings;
    const activeQueueChanged = this.activeQueueEnabled !== activeQueueEnabled;
    const taskSourceChanged = this.taskSource !== taskSource;
    if (!contextRingsChanged && !activeQueueChanged && !taskSourceChanged) return;
    this.showContextRings = showContextRings;
    this.activeQueueEnabled = activeQueueEnabled;
    this.taskSource = taskSource;
    if (activeQueueChanged || taskSourceChanged) {
      this.activeQueueRankIndex.clear();
      if (taskSourceChanged) {
        const synchronize = this.syncOpenCodeCollectorDemand();
        void this.refreshDisplay().catch(() => streamDeck.logger.error("Agent display settings refresh failed."));
        void synchronize.then(() => this.refreshDisplay()).catch(() =>
          streamDeck.logger.error("Agent display settings refresh failed."));
      } else {
        void this.refreshDisplay().catch(() => streamDeck.logger.error("Agent display settings refresh failed."));
      }
    } else {
      void Promise.all([...this.agents.values()].map((registration) => this.renderAgent(registration)));
    }
  }

  registerMicroAction(slot: MicroActionSlot, action: KeyAction): void {
    this.microActions.set(action.id, { action, slot });
    void this.renderMicroAction({ action, slot });
  }

  unregisterMicroAction(action: ActionIdentity): void {
    this.unregister(action, this.microActions);
  }

  registerFixedAction(id: string, action: KeyAction, source: FixedIconSource): void {
    this.fixedActions.set(action.id, { action, source });
    void this.renderFixedAction({ action, source });
  }

  unregisterFixedAction(action: ActionIdentity): void {
    this.unregister(action, this.fixedActions);
  }

  registerHostToggle(action: KeyAction): void {
    this.hostToggleActions.set(action.id, action);
    void this.renderHostToggle(action);
  }

  unregisterHostToggle(action: ActionIdentity): void {
    this.hostToggleActions.delete(action.id);
    this.lastImages.delete(action.id);
  }

  registerUsageLimit(action: KeyAction, mode: UsageLimitMode): void {
    const registration = { action, mode };
    this.usageLimitActions.set(action.id, registration);
    this.renderUsageAction("Usage limit", action, () => this.renderUsageLimit(registration));
  }

  updateUsageLimitMode(action: KeyAction, mode: UsageLimitMode): void {
    const registration = { action, mode };
    this.usageLimitActions.set(action.id, registration);
    this.renderUsageAction("Usage limit", action, () => this.renderUsageLimit(registration));
  }

  unregisterUsageLimit(action: ActionIdentity): void {
    this.unregister(action, this.usageLimitActions);
  }

  registerUsageOverview(action: KeyAction): void {
    this.usageOverviewActions.set(action.id, action);
    this.renderUsageAction("Usage overview", action, () => this.renderUsageOverview(action));
  }

  unregisterUsageOverview(action: ActionIdentity): void {
    this.unregister(action, this.usageOverviewActions);
  }

  registerRateLimitReset(action: KeyAction): void {
    this.rateLimitResetActions.set(action.id, action);
    this.renderUsageAction("Rate-limit reset", action, () => this.renderRateLimitReset(action));
  }

  unregisterRateLimitReset(action: ActionIdentity): void {
    this.resetHolds.delete(action.id);
    this.unregister(action, this.rateLimitResetActions);
  }

  beginRateLimitReset(action: ActionIdentity): void {
    this.resetHolds.set(action.id, Date.now());
    const registered = this.rateLimitResetActions.get(action.id);
    if (registered) void this.renderRateLimitReset(registered);
  }

  async finishRateLimitReset(action: ActionIdentity): Promise<boolean> {
    const startedAt = this.resetHolds.get(action.id);
    this.resetHolds.delete(action.id);
    const registered = this.rateLimitResetActions.get(action.id);
    if (registered) await this.renderRateLimitReset(registered);
    if (startedAt == null || Date.now() - startedAt < RESET_HOLD_MS) return false;
    const source = this.accountUsageSource();
    const usage = source.usage ?? source.snapshot?.usage;
    if ((usage?.resetCreditsAvailable ?? 0) <= 0) throw new Error("No rate-limit reset credit is available.");
    if (usage?.resetCreditsApplicable === 0) throw new Error("No rate-limit reset credit is currently applicable.");
    await this.sendToHost(source.hostId, { kind: "rate-limit-reset" }, () => this.microBridge.consumeRateLimitReset());
    await this.refresh();
    return true;
  }

  async toggleTargetHost(): Promise<void> {
    const remote = this.relayClient?.currentHost();
    if (!this.localHost) throw new Error("The local Codex host is not ready.");
    if (this.targetPlatform === this.localHost.platform) {
      if (!remote) throw new Error("No remote Codex host is connected.");
      this.targetPlatform = remote.platform;
      this.targetHostId = remote.hostId;
    } else {
      this.targetPlatform = this.localHost.platform;
      this.targetHostId = this.localHost.hostId;
    }
    await writeControlTarget(this.targetPlatform);
    await this.renderAll();
  }

  async sendAgent(slot: number, act: 0 | 1): Promise<void> {
    if (act === 0 && this.emptyAgentPresses.delete(slot)) {
      this.pressedAgents.delete(slot);
      return;
    }
    const assignment = act === 0 ? this.pressedAgents.get(slot) : this.routedSlots[slot];
    if (act === 1 && this.effectiveActiveQueueEnabled() && !assignment) {
      this.pressedAgents.delete(slot);
      this.emptyAgentPresses.add(slot);
      return;
    }
    if (act === 1) this.emptyAgentPresses.delete(slot);
    if (this.effectiveActiveQueueEnabled() && !assignment) return;
    if (!assignment) throw new Error(`No Codex task is assigned to global agent slot ${slot + 1}.`);
    if (assignment.taskSource === "opencode") {
      if (act === 1) this.pressedAgents.set(slot, assignment);
      else this.pressedAgents.delete(slot);
      if (act === 1) {
        await this.foregroundOpenCodeAction();
        const separator = assignment.threadKey?.indexOf("\0") ?? -1;
        const collector = this.openCodeCollector;
        if (collector && separator > 0 && assignment.threadKey) {
          const connectionId = assignment.threadKey.slice(0, separator);
          const sessionId = assignment.threadKey.slice(separator + 1);
          if (assignment.activityAt !== undefined &&
            collector.acknowledgeTask(connectionId, sessionId, assignment.activityAt)) {
            const publication = collector.publishTaskViewed(connectionId, sessionId);
            await this.refreshDisplay();
            void publication.catch(() => undefined);
          }
        }
      }
      return;
    }
    if (act === 1) this.pressedAgents.set(slot, assignment);
    else this.pressedAgents.delete(slot);
    if (!assignment.threadKey) throw new Error("The selected Codex task has no stable thread identity.");
    if (assignment.host.hostId === this.localHost?.hostId) {
      await this.microBridge.sendAgent(assignment.sourceSlot, act, assignment.threadKey);
    } else await this.sendRemote(
      { kind: "agent", slot: assignment.sourceSlot, threadKey: assignment.threadKey, act },
      assignment.host.hostId
    );
    if (act === 0) void this.refresh();
  }

  async sendMicroAction(slot: MicroActionSlot, act: 0 | 1): Promise<void> {
    const target = this.pressTarget(`action:${slot}`, act);
    await this.sendToHost(target, { kind: "action", slot, act }, () => this.microBridge.sendAction(slot, act));
  }

  async sendJoystick(direction: MicroDirection, distance: 0 | 1): Promise<void> {
    const target = this.pressTarget(`joystick:${direction}`, distance);
    await this.sendToHost(target, { kind: "joystick", direction, distance }, () => this.microBridge.sendJoystick(direction, distance));
  }

  async sendEncoder(act: 0 | 1): Promise<void> {
    const target = this.pressTarget("encoder", act);
    await this.sendToHost(target, { kind: "encoder", act }, () => this.microBridge.sendEncoder(act));
  }

  async adjustReasoning(direction: ReasoningAdjustment): Promise<void> {
    await this.sendToTarget({ kind: "reasoning", direction }, () => this.microBridge.adjustReasoning(direction));
  }

  async runKeycap(keycapId: OfficialKeycapId): Promise<void> {
    await this.sendToTarget({ kind: "keycap", keycapId }, () => this.microBridge.runKeycap(keycapId));
  }

  async createTask(): Promise<void> {
    if (this.isRemoteTarget()) await this.sendRemote({ kind: "keycap", keycapId: "NEW" });
    else await openCodexThread("new");
  }

  private async refresh(): Promise<void> {
    if (this.refreshInFlight) return this.refreshInFlight;
    const pending = this.refreshOnce();
    this.refreshInFlight = pending;
    try { await pending; }
    finally { if (this.refreshInFlight === pending) this.refreshInFlight = undefined; }
  }

  private async refreshOnce(): Promise<void> {
    if (process.platform === "darwin") this.codexBarUsage = await readCodexBarUsage();
    try {
      const snapshot = await this.microBridge.refresh();
      this.localHost = await getOrCreateHostIdentity();
      this.mobileRelayServer?.updateHost(this.localHost);
      this.localMobileRelayServer?.updateHost(this.localHost);
      this.localSnapshot = { host: this.localHost, snapshot, observedAt: Date.now() };
      this.localHealth = { state: "ready", changedAt: Date.now() };
      this.lastError = "";
    } catch (error) {
      this.localHealth = { state: "degraded", reason: localBridgeFailureReason(error), changedAt: Date.now() };
      const message = String(error);
      if (message !== this.lastError) {
        this.lastError = message;
        streamDeck.logger.warn(`Codex Micro bridge unavailable: ${message}`);
      }
    }
    await this.refreshDisplay();
  }

  private async syncOpenCodeCollectorDemand(): Promise<void> {
    const demanded = this.openCodeDemanded();
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
      if (generation !== this.openCodeDemandGeneration || !this.openCodeDemanded()) return;
      const collector = new OpenCodeCollector({ identitySecret: secret });
      this.openCodeCollector = collector;
      const snapshot = await collector.start();
      if (generation !== this.openCodeDemandGeneration || !this.openCodeDemanded()) {
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
      streamDeck.logger.warn("OpenCode collector is unavailable.");
    }
  }

  private refreshOpenCodeSnapshot(): void {
    const collector = this.openCodeCollector;
    if (!collector) return;
    this.applyOpenCodeSnapshot(collector.snapshot());
  }

  private openCodeDemanded(): boolean {
    return !this.stopped && shouldCollectOpenCode(this.taskSource, process.platform);
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
        this.openCodeSlot(task, sourceSlot, connectionObservedAt));
  }

  private openCodeSlot(task: OpenCodeTask, sourceSlot: number, observedAt: number): RoutedAgentSlot {
    return {
      id: sourceSlot,
      sourceSlot,
      catalogIndex: sourceSlot,
      taskSource: "opencode",
      host: this.localHost!,
      threadKey: `${task.connectionId}\0${task.sessionId}`,
      conversationId: `${task.connectionId}\0${task.sessionId}`,
      title: task.displayTitle ?? task.label,
      status: task.status,
      selected: false,
      activityAt: task.terminalAt ?? task.workStartedAt,
      workStartedAt: task.workStartedAt,
      workStartRevision: task.workStartRevision,
      observedAt
    };
  }

  private async refreshDisplay(): Promise<void> {
    this.refreshOpenCodeSnapshot();
    const remoteSnapshot = this.relayClient?.currentSnapshot();
    if (this.localHost && this.targetPlatform !== this.localHost.platform && remoteSnapshot) this.targetHostId = remoteSnapshot.host.hostId;
    else if (this.localHost && this.targetPlatform === this.localHost.platform) this.targetHostId = this.localHost.hostId;
    const inputs = [this.localSnapshot, remoteSnapshot].filter((value): value is HostSnapshot => value != null);
    const remoteHealth: HostHealth = this.relayClient?.currentHealth() ?? {
      state: "offline",
      reason: "relay-disconnected",
      changedAt: Date.now()
    };
    const healthSignature = `local=${this.localHealth.state}:${this.localHealth.reason ?? ""},remote=${remoteHealth.state}:${remoteHealth.reason ?? ""}`;
    if (healthSignature !== this.lastHostHealthSignature) {
      this.lastHostHealthSignature = healthSignature;
      streamDeck.logger.info(`Codex host health: ${healthSignature}`);
    }
    const agentSources = inputs.map((input) => `${input.host.platform}=${input.snapshot.agentSource}`);
    const agentSourceSignature = agentSources.join(",");
    if (agentSourceSignature !== this.lastAgentSourceSignature) {
      this.lastAgentSourceSignature = agentSourceSignature;
      if (new Set(inputs.map((input) => input.snapshot.agentSource)).size > 1) {
        streamDeck.logger.warn(`Codex agent sources differ (${agentSources.join(" ")}). The Windows controller mode determines the combined list; Pinned and Individual assignments merge only hosts using that mode.`);
      }
    }
    const now = Date.now();
    const activeQueueEnabled = this.effectiveActiveQueueEnabled();
    const queueInputs = activeQueueEnabled && this.localHealth.reason === "codex-not-running"
      ? inputs.filter((input) => input.host.hostId !== this.localHost?.hostId)
      : inputs;
    const codexSlots = activeQueueEnabled
      ? this.activityIndex.mergeActiveCatalog(queueInputs, now, this.localHost?.hostId)
      : this.activityIndex.merge(inputs, now, this.localHost?.hostId);
    const merged = selectTaskCandidates(this.taskSource, codexSlots, this.openCodeSlots);
    this.routedSlots = activeQueueEnabled
      ? projectActiveQueue(merged, queueInputs, this.activeQueueRankIndex, now)
      : merged;

    const assignments = this.routedSlots.map((slot) => `${slot.id}=${slot.taskSource ?? "codex"}:${slot.host.platform}`).join(" ");
    if (assignments !== this.lastAssignmentSignature) {
      this.lastAssignmentSignature = assignments;
      streamDeck.logger.info(`Agent slots: ${assignments || "empty"}`);
    }

    const statuses = this.routedSlots.map((slot) => `${slot.taskSource ?? "codex"}:${slot.host.hostId}:${slot.status}:${slot.selected}`).join(",");
    if (statuses !== this.lastStatusSignature) {
      this.lastStatusSignature = statuses;
      streamDeck.logger.info(`Agent states: ${this.routedSlots.map((slot) => `${slot.id + 1}=${slot.status}`).join(" ") || "empty"}`);
    }

    const target = this.targetSnapshot();
    const layout = JSON.stringify({ target: this.targetHostId, theme: target?.theme, slots: target?.layout.slots });
    if (layout !== this.lastLayoutSignature) {
      this.lastLayoutSignature = layout;
      this.keycapImages.clear();
      if (target) streamDeck.logger.info(`Codex Micro layout synchronized (${target.agentSource}, ${target.theme} theme).`);
    }
    await this.renderAll();
  }

  private async renderAll(): Promise<void> {
    await Promise.all([
      ...[...this.agents.values()].map((registration) => this.renderAgent(registration)),
      ...[...this.microActions.values()].map((registration) => this.renderMicroAction(registration)),
      ...[...this.fixedActions.values()].map((registration) => this.renderFixedAction(registration)),
      ...[...this.hostToggleActions.values()].map((action) => this.renderHostToggle(action)),
      ...[...this.usageLimitActions.values()].map((registration) => this.renderUsageLimit(registration)),
      ...[...this.usageOverviewActions.values()].map((action) => this.renderUsageOverview(action)),
      ...[...this.rateLimitResetActions.values()].map((action) => this.renderRateLimitReset(action))
    ]);
  }

  private async renderAgent({ action, slot }: AgentRegistration): Promise<void> {
    const agent = this.routedSlots[slot];
    const health = agent?.taskSource === "opencode" ? this.openCodeHealth
      : agent ? this.healthForHost(agent.host) : this.selectedTaskHealth();
    const isLocalAgent = agent ? agent.host.hostId === this.localHost?.hostId : !this.isRemoteTarget();
    const codexStopped = slot < 4 && isLocalAgent && health.state === "degraded" && health.reason === "codex-not-running";
    const healthyQueueGap = this.effectiveActiveQueueEnabled() && !agent && health.state === "ready";
    if (codexStopped || healthyQueueGap) {
      await this.setImage(action, renderAgentBlackKey());
      return;
    }
    const unavailableTitle = health.state === "degraded" ? "Signals uncertain"
      : health.state === "offline" ? "Host offline"
        : health.state === "connecting" ? "Connecting" : "Not assigned";
    const title = agent?.title ?? (agent?.threadKey && health.state === "ready" ? "New chat" : unavailableTitle);
    const status = agent ? visualStatusFromMicro(agent.status) : "empty";
    const theme = this.targetSnapshot()?.theme ?? this.localSnapshot?.snapshot.theme ?? "light";
    const hostBadge = agent?.taskSource === "opencode" ? "O"
      : agent && this.relayClient ? (agent.host.platform === "darwin" ? "M" : "W") : undefined;
    await this.setImage(action, renderAgentKey(
      slot, title, status, agent?.selected ?? false, this.animationFrame, theme, hostBadge,
      health.state, agent?.contextUsedPercent, this.showContextRings && agent?.taskSource !== "opencode"));
  }

  private async renderAnimatedAgents(): Promise<void> {
    const registrations = [...this.agents.values()].filter(({ slot }) => {
      const agent = this.routedSlots[slot];
      if (!agent) return false;
      const status = visualStatusFromMicro(agent.status);
      return status === "thinking" || status === "input";
    });
    await Promise.all(registrations.map((registration) => this.renderAgent(registration).catch((error) =>
      streamDeck.logger.error(`Agent animation ${registration.slot + 1} failed: ${String(error)}`)
    )));
  }

  private async renderMicroAction({ action, slot }: MicroActionRegistration): Promise<void> {
    const snapshot = this.targetSnapshot();
    const keycapId = snapshot?.layout.slots[slot]?.keycapId;
    if (!keycapId) return;
    const image = await this.keycapImage(keycapId, snapshot?.theme ?? "dark");
    if (image) await this.setImage(action, image);
  }

  private async renderFixedAction(registration: FixedIconRegistration): Promise<void> {
    const theme = this.targetSnapshot()?.theme ?? "dark";
    const image = registration.source.kind === "builtin"
      ? renderBuiltinKeycap(registration.source.name, theme)
      : await this.keycapImage(registration.source.keycapId, theme);
    if (image) await this.setImage(registration.action, image);
  }

  private async renderHostToggle(action: KeyAction): Promise<void> {
    const label = this.targetPlatform === "darwin" ? "MAC" : "WIN";
    const theme = this.targetSnapshot()?.theme ?? "dark";
    await this.setImage(action, renderHostTargetKey(label, this.targetHealth().state, theme));
  }

  private async renderUsageLimit({ action, mode }: UsageLimitRegistration): Promise<void> {
    const source = this.accountUsageSource();
    const usage = source.usage ?? source.snapshot?.usage;
    const window = selectUsageWindow(usage, mode);
    const requestedKind: UsageWindowKind = mode === "auto" ? (window?.kind ?? "other") : mode;
    await this.setImage(action, renderUsageLimitKey(window, requestedKind, usageTheme(source), source.health.state));
  }

  private async renderUsageOverview(action: KeyAction): Promise<void> {
    const source = this.accountUsageSource();
    const usage = source.usage ?? source.snapshot?.usage;
    await this.setImage(action, renderUsageOverviewKey(usage?.windows ?? [], usageTheme(source), source.health.state));
  }

  private async renderRateLimitReset(action: KeyAction): Promise<void> {
    const source = this.accountUsageSource();
    const usage = source.usage ?? source.snapshot?.usage;
    const startedAt = this.resetHolds.get(action.id);
    const progress = startedAt == null ? 0 : Math.min(1, (Date.now() - startedAt) / RESET_HOLD_MS);
    await this.setImage(action, renderRateLimitResetKey(
      usage?.resetCreditsAvailable ?? null,
      progress,
      usageTheme(source),
      source.health.state
    ));
  }

  private async renderResetHolds(): Promise<void> {
    await Promise.all([...this.resetHolds.keys()].map(async (id) => {
      const action = this.rateLimitResetActions.get(id);
      if (action) await this.renderRateLimitReset(action);
    }));
  }

  private targetHealth(): HostHealth {
    if (!this.localHost || this.targetPlatform === this.localHost.platform) return this.localHealth;
    return this.relayClient?.currentHealth() ?? { state: "offline", reason: "relay-disconnected", changedAt: Date.now() };
  }

  private healthForHost(host: CodexHost): HostHealth {
    if (host.hostId === this.localHost?.hostId) return this.localHealth;
    if (host.hostId === this.relayClient?.currentHost()?.hostId) return this.relayClient!.currentHealth();
    return { state: "offline", reason: "relay-disconnected", changedAt: Date.now() };
  }

  private selectedTaskHealth(): HostHealth {
    if (this.taskSource === "OpenCode") return this.openCodeHealth;
    if (this.taskSource === "Codex") return this.targetHealth();
    const codex = this.targetHealth();
    if (codex.state === "ready" || this.openCodeHealth.state === "ready") {
      return { state: "ready", changedAt: Math.max(codex.changedAt, this.openCodeHealth.changedAt) };
    }
    return this.openCodeHealth.state === "connecting" ? codex : this.openCodeHealth;
  }

  private targetSnapshot(): MicroSnapshot | undefined {
    const remote = this.relayClient?.currentSnapshot();
    if (this.localHost && this.targetPlatform !== this.localHost.platform) return remote?.snapshot;
    return this.localSnapshot?.snapshot;
  }

  private accountUsageSource(): AccountUsageSource {
    const bridgeUsage = this.localSnapshot?.snapshot.usage;
    const macUsage = composeMacUsage(this.codexBarUsage, bridgeUsage);
    const localUsage = this.localHost?.platform === "darwin" ? macUsage : bridgeUsage;
    const localUsageHealth: HostHealth = this.localHost?.platform === "darwin"
      ? this.codexBarUsage
        ? { state: "ready", changedAt: this.codexBarUsage.observedAt }
        : this.localHealth.state === "ready"
          ? { state: "degraded", reason: "snapshot-stale", changedAt: Date.now() }
          : this.localHealth
      : localUsage
        ? { state: "ready", changedAt: localUsage.observedAt }
        : this.localHealth;
    const local: AccountUsageSource = {
      health: localUsageHealth,
      hostId: this.localHost?.hostId,
      snapshot: this.localSnapshot?.snapshot,
      usage: localUsage,
      theme: this.localSnapshot?.snapshot.theme
    };
    const remoteSnapshot = this.relayClient?.currentSnapshot();
    const remote: AccountUsageSource | undefined = remoteSnapshot ? {
      health: this.relayClient?.currentHealth() ?? { state: "offline", reason: "relay-disconnected", changedAt: Date.now() },
      hostId: remoteSnapshot.host.hostId,
      snapshot: remoteSnapshot.snapshot,
      usage: remoteSnapshot.snapshot.usage,
      theme: remoteSnapshot.snapshot.theme
    } : undefined;
    return this.localHost?.platform === "darwin" ? local : selectAccountUsageSource(local, remote);
  }

  private isRemoteTarget(): boolean {
    return this.localHost != null && this.targetPlatform !== this.localHost.platform;
  }

  private async sendRemote(command: RelayCommand, expectedHostId?: string): Promise<void> {
    if (!this.relayClient) throw new Error("Remote Codex relay is not configured.");
    await this.relayClient.send(command, expectedHostId);
  }

  private async sendToTarget(command: RelayCommand, local: () => Promise<void>): Promise<void> {
    await this.sendToHost(this.targetHostId, command, local);
  }

  private async sendToHost(hostId: string | undefined, command: RelayCommand, local: () => Promise<void>): Promise<void> {
    const localHostId = this.localHost?.hostId;
    const remoteRequested = isRemoteControlRequest(this.targetPlatform, this.localHost?.platform ?? "win32", hostId, localHostId);
    if (remoteRequested) await this.sendRemote(command);
    else await local();
  }

  private pressTarget(key: string, pressed: 0 | 1): string | undefined {
    if (pressed === 1) {
      const target = this.targetHostId;
      if (target) this.pressedControlTargets.set(key, target);
      return target;
    }
    const target = this.pressedControlTargets.get(key) ?? this.targetHostId;
    this.pressedControlTargets.delete(key);
    return target;
  }

  private async setImage(action: KeyAction, image: string): Promise<void> {
    if (this.lastImages.get(action.id) === image) return;
    await Promise.all([action.setImage(image), action.setTitle("")]);
    this.lastImages.set(action.id, image);
  }

  private effectiveActiveQueueEnabled(): boolean {
    return usesActiveQueue(this.taskSource, this.activeQueueEnabled);
  }

  private renderUsageAction(label: string, action: KeyAction, render: () => Promise<void>): void {
    void render()
      .then(() => streamDeck.logger.info(`${label} action rendered (${action.id}).`))
      .catch((error) => streamDeck.logger.error(`${label} action render failed (${action.id}): ${String(error)}`));
  }

  private unregister<T>(action: ActionIdentity, registrations: Map<string, T>): void {
    registrations.delete(action.id);
    this.lastImages.delete(action.id);
  }

  private scheduleRefresh(): void {
    if (this.stopped) return;
    this.poll = setTimeout(async () => {
      try { await this.refresh(); }
      finally { this.scheduleRefresh(); }
    }, 1_200);
  }

  private scheduleAnimation(): void {
    if (this.stopped) return;
    this.animation = setTimeout(async () => {
      this.animationFrame = (this.animationFrame + 1) % 12;
      try { await Promise.all([this.renderAnimatedAgents(), this.renderResetHolds()]); }
      finally { this.scheduleAnimation(); }
    }, 200);
  }

  private keycapImage(keycapId: string, theme: "light" | "dark"): Promise<string | null> {
    const cacheKey = `${theme}:${keycapId}`;
    let pending = this.keycapImages.get(cacheKey);
    if (pending) return pending;
    pending = readFile(join(USER_ICON_ROOT, `${keycapId}.svg`), "utf8")
      .then((svg) => renderImportedKeycap(svg, theme))
      .catch(() => renderFallbackKeycap(keycapId, theme));
    this.keycapImages.set(cacheKey, pending);
    return pending;
  }
}
