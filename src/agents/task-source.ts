import type { TaskSource } from "./types.js";

export function parseTaskSource(value: unknown): TaskSource {
  if (value === "Both") return "All";
  return value === "OpenCode" || value === "T3 Code" || value === "All" ? value : "Codex";
}

export function usesActiveQueue(source: TaskSource, codexPreference: boolean): boolean {
  return source !== "Codex" || codexPreference;
}

export function shouldCollectOpenCode(source: TaskSource, platform: NodeJS.Platform): boolean {
  return platform === "darwin" && (source === "OpenCode" || source === "All");
}

export function selectTaskCandidates<T>(
  source: TaskSource,
  codex: readonly T[],
  openCode: readonly T[],
  t3Code: readonly T[] = [],
): T[] {
  if (source === "Codex") return [...codex];
  if (source === "OpenCode") return [...openCode];
  if (source === "T3 Code") return [...t3Code];
  return [...codex, ...openCode, ...t3Code];
}
