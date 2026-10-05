import { constants } from "node:fs";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { codexDeckStateRoot } from "../src/runtime/paths.js";
import { withT3ConfigLock } from "./t3-config-lock.mjs";
import { t3SshRequest, validateSshConnection, validateSshHost } from "#t3code";

async function connect() {
  if (process.platform !== "darwin" || process.argv.length !== 3) throw new Error("Expected one SSH alias");
  const host = process.argv[2]!;
  validateSshHost(host);
  const root = codexDeckStateRoot("darwin");
  const path = join(root, "t3code.json");
  let config: Record<string, unknown> = {};
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await file.stat();
      if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0 || info.size > 16384)
        throw new Error("Unprotected configuration");
      config = JSON.parse(await file.readFile("utf8"));
    } finally {
      await file.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const saved = config.sshConnections ?? [];
  if (!Array.isArray(saved) || saved.length > 8) throw new Error("Invalid saved connections");
  const connections = saved.map(validateSshConnection);
  // Reuse an already authenticated session; do not create duplicates on retries.
  const existing = connections.find((connection) => connection.host === host);
  if (existing) await t3SshRequest(host, existing, new AbortController().signal);
  else {
    if (connections.length >= 8) throw new Error("Connection limit");
    const paired = await t3SshRequest(host, { pair: true }, new AbortController().signal);
    const connection = validateSshConnection({ ...(paired as object), host });
    if (connections.some((item) => item.environmentId === connection.environmentId))
      throw new Error("Duplicate environment");
    connections.push(connection);
  }
  await mkdir(root, { recursive: true, mode: 0o700 });
  const contents = `${JSON.stringify({ ...config, sshConnections: connections })}\n`;
  if (Buffer.byteLength(contents) > 16384) throw new Error("Configuration too large");
  const temporary = `${path}.${process.pid}.tmp`;
  const file = await open(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await file.writeFile(contents);
    await file.close();
    await rename(temporary, path);
  } catch (error) {
    await file.close();
    await rm(temporary, { force: true });
    throw error;
  }
  console.log("T3 Code SSH read-only connection ready; existing local connection preserved.");
}

try {
  await withT3ConfigLock(connect);
} catch {
  console.error(
    "T3 Code SSH connection failed. Check the saved SSH alias, known host, running T3 server and remote Python 3. Existing configuration was preserved.",
  );
  process.exitCode = 1;
}
