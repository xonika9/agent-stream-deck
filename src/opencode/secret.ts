import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { join } from "node:path";
import { codexDeckStateRoot } from "../runtime/paths.js";

const SECRET_BYTES = 32;

export async function getOrCreateOpenCodeIdentitySecret(root = codexDeckStateRoot()): Promise<Buffer> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const rootMetadata = await lstat(root);
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (
    !rootMetadata.isDirectory() ||
    rootMetadata.isSymbolicLink() ||
    (rootMetadata.mode & 0o022) !== 0 ||
    (uid != null && rootMetadata.uid !== uid)
  )
    throw new Error("Codex Deck state directory is unsafe.");
  const path = join(root, "opencode-identity.key");
  const created = randomBytes(SECRET_BYTES);
  try {
    const handle = await open(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(created);
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (!record(error) || error.code !== "EEXIST") throw error;
  }

  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (
      !metadata.isFile() ||
      metadata.size !== SECRET_BYTES ||
      (metadata.mode & 0o077) !== 0 ||
      (uid != null && metadata.uid !== uid)
    )
      throw new Error("OpenCode identity secret is unsafe.");
    const value = await handle.readFile();
    if (value.length !== SECRET_BYTES) throw new Error("OpenCode identity secret is invalid.");
    return value;
  } finally {
    await handle.close();
  }
}

function record(value: unknown): value is { code?: unknown } {
  return typeof value === "object" && value !== null;
}
