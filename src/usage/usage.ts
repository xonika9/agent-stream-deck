import type {
  CodexHost,
  HostSnapshot,
  HostHealth,
  MicroSnapshot,
  ThemeMode,
  UsageLimitMode,
  UsageSnapshot,
  UsageSource,
  UsageWindow,
  UsageWindowKind,
} from "#agents";

export type AccountUsageSource = {
  health: HostHealth;
  hostId?: string;
  snapshot?: MicroSnapshot;
  usage?: UsageSnapshot;
  theme?: ThemeMode;
};

export const FIVE_HOUR_MINUTES = 5 * 60;
export const WEEKLY_MINUTES = 7 * 24 * 60;

export function usageWindowKind(minutes: number | null): UsageWindowKind {
  if (minutes != null && Math.abs(minutes - FIVE_HOUR_MINUTES) <= 1) return "five-hour";
  if (minutes != null && Math.abs(minutes - WEEKLY_MINUTES) <= 1) return "weekly";
  return "other";
}

export function selectUsageWindow(usage: UsageSnapshot | undefined, mode: UsageLimitMode): UsageWindow | undefined {
  const windows = usage?.windows ?? [];
  if (mode !== "auto") return windows.find((window) => window.kind === mode);
  return (
    windows.find((window) => window.kind === "five-hour") ??
    windows.find((window) => window.kind === "weekly") ??
    [...windows].sort(
      (left, right) =>
        (left.windowDurationMins ?? Number.MAX_SAFE_INTEGER) - (right.windowDurationMins ?? Number.MAX_SAFE_INTEGER),
    )[0]
  );
}

export type UsageOverviewWindow = Exclude<UsageWindowKind, "other">;

export function selectUsageBarWindow(
  usage: UsageSnapshot | undefined,
  kind: UsageOverviewWindow,
): UsageWindow | undefined {
  return selectUsageWindow(usage, kind);
}

const CODEX_MODES: UsageLimitMode[] = ["auto", "five-hour", "weekly"];

const MODES_BY_SOURCE: Record<UsageSource, UsageLimitMode[]> = {
  "codex-auto": CODEX_MODES,
  "codex-bar": CODEX_MODES,
  "codex-app": CODEX_MODES,
  "t3-codex": CODEX_MODES,
  "t3-claude": ["auto", "five-hour", "weekly", "weekly-fable"],
  "t3-opencode": ["auto", "five-hour", "weekly", "monthly"],
};

export function isT3UsageSource(source: UsageSource): source is "t3-codex" | "t3-claude" | "t3-opencode" {
  return source === "t3-codex" || source === "t3-claude" || source === "t3-opencode";
}

export function parseUsageSource(value: unknown, platform: string = process.platform): UsageSource {
  if (platform === "win32") return "codex-auto";
  return value === "codex-auto" ||
    value === "codex-bar" ||
    value === "codex-app" ||
    value === "t3-codex" ||
    value === "t3-claude" ||
    value === "t3-opencode"
    ? value
    : "codex-auto";
}

export function parseUsageLimitMode(value: unknown, source: UsageSource = "codex-auto"): UsageLimitMode {
  const allowed = MODES_BY_SOURCE[source] ?? CODEX_MODES;
  return allowed.includes(value as UsageLimitMode) ? (value as UsageLimitMode) : "auto";
}

export function parseUsageBarWindow(value: unknown, fallback: UsageOverviewWindow): UsageOverviewWindow {
  return value === "five-hour" || value === "weekly" || value === "weekly-fable" || value === "monthly"
    ? value
    : fallback;
}

export type UsageKeySettings = {
  source: UsageSource;
  mode: UsageLimitMode;
  topWindow: UsageOverviewWindow;
  bottomWindow: UsageOverviewWindow;
  showRemaining: boolean;
};

export function parseUsageSettings(settings: unknown, platform: string = process.platform): UsageKeySettings {
  const record: Record<string, unknown> =
    typeof settings === "object" && settings !== null && !Array.isArray(settings)
      ? (settings as Record<string, unknown>)
      : {};
  const source = parseUsageSource(record.source, platform);
  return {
    source,
    mode: parseUsageLimitMode(record.mode, source),
    topWindow: parseUsageBarWindow(record.topWindow, "five-hour"),
    bottomWindow: parseUsageBarWindow(record.bottomWindow, "weekly"),
    showRemaining: record.showRemaining === true,
  };
}

export function usageLabel(kind: UsageWindowKind): string {
  if (kind === "five-hour") return "5H";
  if (kind === "weekly") return "WK";
  if (kind === "weekly-fable") return "FBL";
  if (kind === "monthly") return "MO";
  return "LIMIT";
}

export function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

export function usageTheme(source: AccountUsageSource): ThemeMode {
  return source.theme ?? source.snapshot?.theme ?? "light";
}

/** macOS Codex data: fresh CodexBar first for automatic, the app bridge as fallback. */
export function composeMacUsage(
  codexBar: UsageSnapshot | undefined,
  bridge: UsageSnapshot | undefined,
  source: UsageSource = "codex-auto",
): UsageSnapshot | undefined {
  if (source === "codex-app") return bridgeWindows(bridge);
  if (source === "codex-bar") {
    if (codexBar) return withBridgeCredits(codexBar, bridge);
    return resetCreditsOnly(bridge);
  }
  if (codexBar) return withBridgeCredits(codexBar, bridge);
  return bridgeWindows(bridge) ?? resetCreditsOnly(bridge);
}

function withBridgeCredits(codexBar: UsageSnapshot, bridge: UsageSnapshot | undefined): UsageSnapshot {
  return {
    ...codexBar,
    resetCreditsAvailable: bridge?.resetCreditsAvailable ?? null,
    resetCreditsApplicable: bridge?.resetCreditsApplicable ?? null,
  };
}

function bridgeWindows(bridge: UsageSnapshot | undefined): UsageSnapshot | undefined {
  return bridge && bridge.windows.length > 0 ? bridge : undefined;
}

function resetCreditsOnly(bridge: UsageSnapshot | undefined): UsageSnapshot | undefined {
  if (!bridge || (bridge.resetCreditsAvailable == null && bridge.resetCreditsApplicable == null)) return;
  return {
    windows: [],
    observedAt: bridge.observedAt,
    resetCreditsAvailable: bridge.resetCreditsAvailable,
    resetCreditsApplicable: bridge.resetCreditsApplicable,
  };
}

export function selectAccountUsage(
  localHost: CodexHost | undefined,
  localSnapshot: HostSnapshot | undefined,
  localHealth: HostHealth,
  codexBarUsage: UsageSnapshot | undefined,
  source: UsageSource = "codex-auto",
): AccountUsageSource {
  const bridgeUsage = localSnapshot?.snapshot.usage;
  if (localHost?.platform !== "darwin") {
    const localUsage = bridgeUsage;
    const localUsageHealth: HostHealth = localUsage
      ? { state: "ready", changedAt: localUsage.observedAt }
      : localHealth;
    return {
      health: localUsageHealth,
      hostId: localHost?.hostId,
      snapshot: localSnapshot?.snapshot,
      usage: localUsage,
      theme: localSnapshot?.snapshot.theme,
    };
  }
  const codexSource = source === "codex-bar" || source === "codex-app" ? source : "codex-auto";
  const macUsage = composeMacUsage(codexBarUsage, bridgeUsage, codexSource);
  const localUsageHealth: HostHealth =
    macUsage && macUsage.windows.length > 0
      ? { state: "ready", changedAt: macUsage.observedAt }
      : localHealth.state === "ready"
        ? { state: "degraded", reason: "snapshot-stale", changedAt: Date.now() }
        : localHealth;
  return {
    health: localUsageHealth,
    hostId: localHost?.hostId,
    snapshot: localSnapshot?.snapshot,
    usage: macUsage,
    theme: localSnapshot?.snapshot.theme,
  };
}
