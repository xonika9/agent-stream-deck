import type {
  CodexHost,
  HostSnapshot,
  HostHealth,
  MicroSnapshot,
  ThemeMode,
  UsageLimitMode,
  UsageSnapshot,
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
  if (mode === "five-hour" || mode === "weekly") return windows.find((window) => window.kind === mode);
  return (
    windows.find((window) => window.kind === "five-hour") ??
    windows.find((window) => window.kind === "weekly") ??
    [...windows].sort(
      (left, right) =>
        (left.windowDurationMins ?? Number.MAX_SAFE_INTEGER) - (right.windowDurationMins ?? Number.MAX_SAFE_INTEGER),
    )[0]
  );
}

export function parseUsageLimitMode(value: unknown): UsageLimitMode {
  return value === "five-hour" || value === "weekly" ? value : "auto";
}

export function usageLabel(kind: UsageWindowKind): string {
  if (kind === "five-hour") return "5H";
  if (kind === "weekly") return "WK";
  return "LIMIT";
}

export function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

export function usageTheme(source: AccountUsageSource): ThemeMode {
  return source.theme ?? source.snapshot?.theme ?? "light";
}

/** macOS quota windows are authoritative only when they came from CodexBar. */
export function composeMacUsage(
  codexBar: UsageSnapshot | undefined,
  bridge: UsageSnapshot | undefined,
): UsageSnapshot | undefined {
  if (codexBar)
    return {
      ...codexBar,
      resetCreditsAvailable: bridge?.resetCreditsAvailable ?? null,
      resetCreditsApplicable: bridge?.resetCreditsApplicable ?? null,
    };
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
): AccountUsageSource {
  const bridgeUsage = localSnapshot?.snapshot.usage;
  const macUsage = composeMacUsage(codexBarUsage, bridgeUsage);
  const localUsage = localHost?.platform === "darwin" ? macUsage : bridgeUsage;
  const localUsageHealth: HostHealth =
    localHost?.platform === "darwin"
      ? codexBarUsage
        ? { state: "ready", changedAt: codexBarUsage.observedAt }
        : localHealth.state === "ready"
          ? { state: "degraded", reason: "snapshot-stale", changedAt: Date.now() }
          : localHealth
      : localUsage
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
