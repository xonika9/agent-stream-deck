import { constants } from "node:fs";
import { mkdir, open, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export async function withT3ConfigLock(update) {
  if (process.platform !== "darwin") throw new Error("T3 connection requires macOS");
  const root = join(homedir(), "Library", "Application Support", "CodexDeck");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const path = join(root, "t3code-connect.lock");
  const deadline = Date.now() + 30000;
  let lock;
  while (!lock) {
    try {
      lock = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    } catch (error) {
      if (error.code !== "EEXIST" || Date.now() >= deadline) throw new Error("T3 connection is locked");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  try {
    return await update();
  } finally {
    await lock.close();
    await rm(path);
  }
}
