import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";

export type StateRoots = { target: string; legacy: string };

/** The Agent Deck state directory and the pre-rename `CodexDeck` directory it replaces. */
export function stateRoots(
  targetPlatform = process.platform,
  home = homedir(),
  localAppData = process.env.LOCALAPPDATA,
): StateRoots {
  if (targetPlatform === "darwin") {
    const parent = posix.join(home, "Library", "Application Support");
    return { target: posix.join(parent, "AgentDeck"), legacy: posix.join(parent, "CodexDeck") };
  }
  const parent = localAppData ?? win32.join(home, "AppData", "Local");
  return { target: win32.join(parent, "AgentDeck"), legacy: win32.join(parent, "CodexDeck") };
}

/**
 * Resolved on every call: only the launcher installer moves the legacy directory (after it has
 * stopped the old watcher), and a running plugin must follow that move without a restart.
 * The new directory wins whenever it exists, so newer data is never shadowed by legacy data.
 */
export function agentDeckStateRoot(
  targetPlatform = process.platform,
  home = homedir(),
  localAppData = process.env.LOCALAPPDATA,
): string {
  const { target, legacy } = stateRoots(targetPlatform, home, localAppData);
  return !existsSync(target) && existsSync(legacy) ? legacy : target;
}
