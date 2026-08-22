export type AgentVisualStatus = "empty" | "idle" | "thinking" | "complete" | "input" | "error";
export type ThemeMode = "light" | "dark";
export type HostHealthState = "ready" | "degraded" | "offline" | "connecting";
export type UsageLimitMode = "auto" | "five-hour" | "weekly";
export type UsageWindowKind = Exclude<UsageLimitMode, "auto"> | "other";

export type HostHealth = {
  state: HostHealthState;
  reason?: "awaiting-snapshot" | "native-signals-unavailable" | "snapshot-stale" | "relay-disconnected" | "local-bridge-unavailable" | "codex-not-running";
  changedAt: number;
};

export type MicroAgentSlot = {
  id: number;
  threadKey: string | null;
  title: string | null;
  status: string;
  selected: boolean;
  activityAt?: number;
  /** True when this host has the backing Codex rollout file for the task. */
  ownedByHost?: boolean;
  /** Percentage of the current model context window consumed by this task. */
  contextUsedPercent?: number;
  /** Timestamp of the latest structural user_message; no message content is exposed. */
  workStartedAt?: number;
  /** Byte offset of the same structural user_message record. */
  workStartRevision?: number;
};

export type MicroAgentCandidate = {
  /** Exact renderer dispatch key; never replace it with a cross-host alias. */
  threadKey: string;
  /** Trusted backing local conversation identity, when the renderer exposes one. */
  conversationId?: string;
  title: string | null;
  status: string;
  selected: boolean;
  activityAt?: number;
  catalogIndex: number;
  /** Native Micro transport hint when this candidate is also in the six-slot set. */
  nativeSlot?: 0 | 1 | 2 | 3 | 4 | 5;
  ownedByHost?: boolean;
  contextUsedPercent?: number;
  workStartedAt?: number;
  workStartRevision?: number;
};

export type MicroActionSlot = "ACT06" | "ACT07" | "ACT08" | "ACT09" | "ACT10_ACT11" | "ACT12";
export type MicroDirection = "up" | "right" | "down" | "left";
export type ReasoningAdjustment = "decrease" | "increase";

export type MicroLayout = {
  version: 1;
  slots: Record<MicroActionSlot, { keycapId: string; commandId?: string }>;
  analogStick: Record<MicroDirection, unknown>;
};

export type HostSessionPresence = {
  threadId: string;
  activityAt: number;
  status: "idle" | "working" | "complete";
  /** Byte offset of the latest structural task_complete event; no task content is exposed. */
  completionRevision?: number;
  /** Content-free context utilization derived from the latest structural token-count event. */
  contextUsedPercent?: number;
  /** Timestamp of the latest structural user_message; paired atomically with workStartRevision. */
  workStartedAt?: number;
  /** Byte offset of the same structural user_message record. */
  workStartRevision?: number;
};

export type UsageWindow = {
  id: string;
  kind: UsageWindowKind;
  usedPercent: number;
  remainingPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
};

export type UsageSnapshot = {
  windows: UsageWindow[];
  observedAt: number;
  resetCreditsAvailable: number | null;
  resetCreditsApplicable: number | null;
};

export type MicroSnapshot = {
  slots: MicroAgentSlot[];
  /** Authoritative full renderer catalog. Undefined means fall back to the six native slots. */
  activeCatalog?: { complete: true; candidates: MicroAgentCandidate[] };
  /** Task currently open in the Codex renderer, even when it is outside the six native Micro slots. */
  activeThreadKey?: string;
  /** User-visible title for the active task, including tasks outside the six Micro slots. */
  activeThreadTitle?: string;
  layout: MicroLayout;
  agentSource: "pinned" | "recent" | "priority" | "custom";
  lightingAutoOff: string;
  theme: ThemeMode;
  /** Account usage read from Codex's authenticated renderer client. */
  usage?: UsageSnapshot;
  /** Recent local rollout identities used to disambiguate cross-host mirrors. */
  hostSessions?: HostSessionPresence[];
};

export type CodexHost = {
  hostId: string;
  hostName: string;
  platform: "win32" | "darwin";
  codexVersion?: string;
};

export type RoutedAgentSlot = MicroAgentSlot & {
  host: CodexHost;
  sourceSlot: number;
  /** Physical native slot when the task belongs to the host's six-slot set. */
  nativeSlot?: 0 | 1 | 2 | 3 | 4 | 5;
  observedAt: number;
  conversationId?: string;
  catalogIndex?: number;
};
