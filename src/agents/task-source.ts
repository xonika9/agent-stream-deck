import type { TaskSource, TaskSourceName, TaskSourceSet } from "./types.js";

export const TASK_SOURCE_NAMES: readonly TaskSourceName[] = ["Codex", "OpenCode", "T3 Code"];

function isTaskSourceName(value: unknown): value is TaskSourceName {
  return value === "Codex" || value === "OpenCode" || value === "T3 Code";
}

/** Legacy single task source value, kept so an older plugin version still reads downgraded settings. */
export function parseTaskSource(value: unknown): TaskSource {
  if (value === "Both") return "All";
  return value === "OpenCode" || value === "T3 Code" || value === "All" ? value : "Codex";
}

/** Selected task sources. A present `taskSources` array wins; otherwise the legacy value applies. */
export function parseTaskSources(settings: unknown): TaskSourceSet {
  const record =
    settings !== null && typeof settings === "object" && !Array.isArray(settings)
      ? (settings as Record<string, unknown>)
      : {};
  const raw = record.taskSources;
  if (raw !== undefined) {
    if (!Array.isArray(raw)) return new Set<TaskSourceName>(["Codex"]);
    const names = new Set(raw.filter(isTaskSourceName));
    const ordered = TASK_SOURCE_NAMES.filter((name) => names.has(name));
    return new Set<TaskSourceName>(ordered.length > 0 ? ordered : (["Codex"] as const));
  }
  const legacy = parseTaskSource(record.taskSource);
  if (legacy === "All") return new Set<TaskSourceName>(TASK_SOURCE_NAMES);
  return new Set<TaskSourceName>([legacy]);
}

/** Accepts a source set or a legacy single value; legacy strings keep older callers working. */
export function toTaskSourceSet(sources: TaskSourceSet | TaskSource): TaskSourceSet {
  if (typeof sources === "string") return parseTaskSources({ taskSource: sources });
  return sources;
}

/** Nearest legacy value for a set: the single source, or `All` for any combination. */
export function legacyTaskSource(sources: TaskSourceSet | TaskSource): TaskSource {
  const set = toTaskSourceSet(sources);
  if (set.size !== 1) return "All";
  return set.has("OpenCode") ? "OpenCode" : set.has("T3 Code") ? "T3 Code" : "Codex";
}

/** Selected sources in canonical Codex, OpenCode, T3 Code order. */
export function taskSourceNames(sources: TaskSourceSet | TaskSource): TaskSourceName[] {
  const set = toTaskSourceSet(sources);
  return TASK_SOURCE_NAMES.filter((name) => set.has(name));
}

export function taskSourcesEqual(a: TaskSourceSet | TaskSource, b: TaskSourceSet | TaskSource): boolean {
  const first = toTaskSourceSet(a);
  const second = toTaskSourceSet(b);
  return first.size === second.size && TASK_SOURCE_NAMES.every((name) => first.has(name) === second.has(name));
}

export function usesActiveQueue(source: TaskSourceSet | TaskSource, codexPreference: boolean): boolean {
  const set = toTaskSourceSet(source);
  return set.has("OpenCode") || set.has("T3 Code") || codexPreference;
}

export function shouldCollectOpenCode(source: TaskSourceSet | TaskSource, platform: NodeJS.Platform): boolean {
  return platform === "darwin" && toTaskSourceSet(source).has("OpenCode");
}

export function selectTaskCandidates<T>(
  source: TaskSourceSet | TaskSource,
  codex: readonly T[],
  openCode: readonly T[],
  t3Code: readonly T[] = [],
): T[] {
  const set = toTaskSourceSet(source);
  return [
    ...(set.has("Codex") ? codex : []),
    ...(set.has("OpenCode") ? openCode : []),
    ...(set.has("T3 Code") ? t3Code : []),
  ];
}
