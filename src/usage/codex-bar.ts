import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { UsageSnapshot, UsageWindow, UsageWindowKind } from "#agents";

const MAX_SNAPSHOT_BYTES = 1024 * 1024;
export const CODEX_BAR_FRESH_MS = 5 * 60 * 1_000;
const FUTURE_SKEW_MS = 60_000;

export function codexBarSnapshotCandidates(home = homedir()): string[] {
  return [
    join(home, "Library", "Group Containers", "Y5PE65HELJ.com.steipete.codexbar", "widget-snapshot.json"),
    join(home, "Library", "Group Containers", "group.com.steipete.codexbar", "widget-snapshot.json"),
    join(home, "Library", "Application Support", "CodexBar", "widget-snapshot.json")
  ];
}

export async function readCodexBarUsage(
  candidates = codexBarSnapshotCandidates(),
  now = Date.now()
): Promise<UsageSnapshot | undefined> {
  const snapshots = await Promise.all(candidates.map((path) => readCandidate(path, now)));
  return snapshots
    .filter((value): value is UsageSnapshot => value != null)
    .sort((left, right) => right.observedAt - left.observedAt)[0];
}

async function readCandidate(path: string, now: number): Promise<UsageSnapshot | undefined> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const metadata = await handle.stat();
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (!metadata.isFile() || metadata.size <= 0 || metadata.size > MAX_SNAPSHOT_BYTES ||
      (uid != null && metadata.uid !== uid) || (metadata.mode & 0o022) !== 0) return;
    const value = JSON.parse(await handle.readFile("utf8")) as unknown;
    return parseCodexBarUsage(value, now);
  } catch {
    return;
  } finally {
    await handle?.close().catch(() => {});
  }
}

export function parseCodexBarUsage(value: unknown, now = Date.now()): UsageSnapshot | undefined {
  if (!record(value) || !Array.isArray(value.entries)) return;
  const entries = value.entries.flatMap((entry) => {
    if (!record(entry) || !isCodexProvider(entry.provider)) return [];
    const observedAt = dateMillis(entry.updatedAt);
    if (observedAt == null || observedAt > now + FUTURE_SKEW_MS || now - observedAt > CODEX_BAR_FRESH_MS) return [];
    const rows = Array.isArray(entry.usageRows) ? entry.usageRows : [];
    const rowWindows = rows.flatMap((row, index) => parseUsageRow(row, index));
    const fallbackWindows = [entry.primary, entry.secondary, entry.tertiary]
      .flatMap((window, index) => parseWindow(window, `window-${index}`));
    const windows = deduplicateWindows(rowWindows.length ? rowWindows : fallbackWindows);
    return windows.length ? [{ observedAt, windows }] : [];
  });
  const newest = entries.sort((left, right) => right.observedAt - left.observedAt)[0];
  return newest ? {
    windows: newest.windows,
    observedAt: newest.observedAt,
    resetCreditsAvailable: null,
    resetCreditsApplicable: null
  } : undefined;
}

function parseUsageRow(value: unknown, index: number): UsageWindow[] {
  if (!record(value)) return [];
  const id = boundedString(value.id, 64) ?? `row-${index}`;
  if (record(value.window)) return parseWindow(value.window, id, finitePercent(value.percentLeft));
  const remaining = finitePercent(value.percentLeft);
  if (remaining == null) return [];
  return [{ id, kind: "other", usedPercent: 100 - remaining, remainingPercent: remaining,
    windowDurationMins: null, resetsAt: null }];
}

function parseWindow(value: unknown, id: string, rowRemaining?: number): UsageWindow[] {
  if (!record(value)) return [];
  const duration = finiteNonNegative(value.windowMinutes);
  const used = finitePercent(value.usedPercent);
  const remaining = rowRemaining ?? (used == null ? undefined : 100 - used);
  if (remaining == null) return [];
  return [{
    id,
    kind: windowKind(duration),
    usedPercent: rowRemaining == null ? used! : 100 - remaining,
    remainingPercent: remaining,
    windowDurationMins: duration,
    resetsAt: dateMillis(value.resetsAt)
  }];
}

function deduplicateWindows(windows: UsageWindow[]): UsageWindow[] {
  const result = new Map<string, UsageWindow>();
  for (const window of windows) {
    const key = window.kind === "other" ? `other:${window.id}` : window.kind;
    if (!result.has(key)) result.set(key, window);
  }
  return [...result.values()].slice(0, 8);
}

function windowKind(minutes: number | null): UsageWindowKind {
  if (minutes === 300) return "five-hour";
  if (minutes === 10_080) return "weekly";
  return "other";
}

function isCodexProvider(value: unknown): boolean {
  if (value === "codex") return true;
  return record(value) && (value.id === "codex" || value.rawValue === "codex");
}

function dateMillis(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value < 10_000_000_000 ? value * 1_000 : value;
  if (typeof value !== "string" || value.length > 64) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function finitePercent(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100 ? value : undefined;
}

function finiteNonNegative(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function boundedString(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= max ? value : undefined;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
