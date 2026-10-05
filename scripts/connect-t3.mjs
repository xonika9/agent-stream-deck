import { constants } from "node:fs";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { withT3ConfigLock } from "./t3-config-lock.mjs";

async function connect() {
  // A pairing credential arrives through stdin, never argv, logs, or Stream Deck global settings.
  if (process.platform !== "darwin") throw new Error("T3 Code task collection is currently supported on macOS.");
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
    if (input.length > 8192) throw new Error("Token input is too large.");
  }
  const credential = input.trim().startsWith("{") ? JSON.parse(input).credential : input.trim();
  if (typeof credential !== "string" || !/^[A-Za-z0-9._~+/-]{1,8192}={0,2}$/u.test(credential))
    throw new Error("Expected a T3 pairing credential on stdin.");
  const runtime = JSON.parse(await readFile(join(homedir(), ".t3", "userdata", "server-runtime.json"), "utf8"));
  const url = new URL(runtime.origin);
  if (
    runtime.version !== 1 ||
    url.protocol !== "http:" ||
    !["127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.origin !== runtime.origin
  )
    throw new Error("A running local T3 Code server is required.");
  process.kill(runtime.pid, 0);
  const exchange = await fetch(`${url.origin}/oauth/token`, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(4000),
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: credential,
      subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
      requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
      scope: "orchestration:read",
      client_label: "CodexDeck",
      client_device_type: "desktop",
      client_os: "macOS",
    }),
  });
  if (!exchange.ok) throw new Error("T3 Code rejected pairing; configuration was not changed.");
  const session = await exchange.json();
  const token = session.access_token;
  if (
    session.token_type !== "Bearer" ||
    session.scope !== "orchestration:read" ||
    typeof token !== "string" ||
    !/^[A-Za-z0-9._~+/-]{1,8192}={0,2}$/u.test(token)
  )
    throw new Error("T3 Code did not issue a read-only session.");
  const response = await fetch(`${url.origin}/api/orchestration/shell`, {
    headers: { authorization: `Bearer ${token}`, "x-t3-orchestration-protocol": "2" },
    redirect: "error",
    signal: AbortSignal.timeout(4000),
  });
  await response.body?.cancel();
  if (!response.ok) throw new Error("T3 Code rejected the connection; configuration was not changed.");
  const root = join(homedir(), "Library", "Application Support", "CodexDeck");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const path = join(root, "t3code.json");
  let sshConnections;
  try {
    const existing = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await existing.stat();
      if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o077) !== 0 || info.size > 16384)
        throw new Error("Unprotected configuration");
      sshConnections = JSON.parse(await existing.readFile("utf8")).sshConnections;
    } finally {
      await existing.close();
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const contents = `${JSON.stringify({ origin: url.origin, token, sshConnections })}\n`;
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
  console.log("T3 Code connected. Select T3 Code or All in any Agent key's settings.");
}

try {
  await withT3ConfigLock(connect);
} catch {
  console.error(
    "T3 Code connection failed. Check the running local server and create a fresh pairing credential; existing configuration was preserved unless pairing succeeded.",
  );
  process.exitCode = 1;
}
