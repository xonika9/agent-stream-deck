import type { TaskSource } from "./types.js";

export function parseTaskSource(value: unknown): TaskSource {
  return value === "OpenCode" || value === "Both" ? value : "Codex";
}

export function usesActiveQueue(source: TaskSource, codexPreference: boolean): boolean {
  return source !== "Codex" || codexPreference;
}

export function shouldCollectOpenCode(source: TaskSource, platform: NodeJS.Platform): boolean {
  return platform === "darwin" && source !== "Codex";
}

export function selectTaskCandidates<T>(source: TaskSource, codex: readonly T[], openCode: readonly T[]): T[] {
  if (source === "Codex") return [...codex];
  if (source === "OpenCode") return [...openCode];
  return [...codex, ...openCode];
}
