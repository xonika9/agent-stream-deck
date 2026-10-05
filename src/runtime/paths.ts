import { homedir } from "node:os";
import { posix, win32 } from "node:path";

export function codexDeckStateRoot(
  targetPlatform = process.platform,
  home = homedir(),
  localAppData = process.env.LOCALAPPDATA
): string {
  if (targetPlatform === "darwin") return posix.join(home, "Library", "Application Support", "CodexDeck");
  return win32.join(localAppData ?? win32.join(home, "AppData", "Local"), "CodexDeck");
}
