import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer, connect } from "node:net";
import type { OpenCodeProcess } from "./contracts.js";
import { boundedString } from "./validation.js";

export const REMOTE_DISCOVERY_SCRIPT = String.raw`set -eu
cli=$(command -v opencode 2>/dev/null || true)
[ -n "$cli" ] || exit 0
status=$("$cli" service status 2>/dev/null || true)
[ "$status" != stopped ] || exit 0
printf 'OPENCODE_SERVICE_STATUS=%s\n' "$status"
platform=$(uname -s 2>/dev/null || true)
for file in "${"$"}{XDG_STATE_HOME:-$HOME/.local/state}"/opencode/service*.json; do
  [ -f "$file" ] || continue
  [ ! -L "$file" ] || continue
  size=$(wc -c < "$file" | tr -d ' ')
  [ "$size" -le 65536 ] || continue
  case "$platform" in
    Darwin*) uid=$(stat -f %u "$file" 2>/dev/null || true); mode=$(stat -f %Lp "$file" 2>/dev/null || true) ;;
    *) uid=$(stat -c %u "$file" 2>/dev/null || true); mode=$(stat -c %a "$file" 2>/dev/null || true) ;;
  esac
  [ "$uid" = "$(id -u)" ] || continue
  case "$mode" in 400|600) ;; *) continue ;; esac
  printf 'OPENCODE_REGISTRATION_BEGIN\n'
  cat "$file"
  printf '\nOPENCODE_REGISTRATION_END\n'
done
printf 'OPENCODE_PAIR_BEGIN\n'
"$cli" pair 2>/dev/null || true
printf '\nOPENCODE_PAIR_END\nOPENCODE_PAIR_STATUS_BEGIN\n'
identity=$("$cli" api GET /api/info 2>/dev/null || true)
case "$identity" in
  *'"version"'*'"pid"'*) ;;
  *) identity=$("$cli" api GET /api/status 2>/dev/null || true) ;;
esac
printf '%s' "$identity"
printf '\nOPENCODE_PAIR_STATUS_END\n'
`;

export function parseSshTarget(input: string): { host: string; args: string[] } {
  if (!boundedString(input, 2048) || /[\r\n\0]/u.test(input)) throw new Error("ssh-target");
  const tokens = tokenize(input);
  if (tokens[0] === "ssh") tokens.shift();
  const args: string[] = [];
  const options = new Set(["hostname", "user", "port", "identityfile", "identityagent", "identitiesonly", "proxyjump", "proxycommand", "connecttimeout", "addressfamily"]);
  while (tokens[0]?.startsWith("-")) {
    const token = tokens.shift()!;
    if (["-4", "-6", "-C", "-a"].includes(token)) { args.push(token); continue; }
    const flag = token.slice(0, 2);
    if (!["-p", "-l", "-i", "-F", "-J", "-o"].includes(flag)) throw new Error("ssh-option");
    const value = token.length > 2 ? token.slice(2) : tokens.shift();
    if (!value || value.startsWith("-") || value.length > 1024) throw new Error("ssh-option");
    if (flag === "-p" && (!/^\d+$/u.test(value) || Number(value) < 1 || Number(value) > 65535)) throw new Error("ssh-port");
    if (flag === "-o" && !options.has((value.split(/[=\s]/u)[0] ?? "").toLowerCase())) throw new Error("ssh-option");
    args.push(flag, value);
  }
  const host = tokens[0];
  if (tokens.length !== 1 || !host || !/^[A-Za-z0-9_@.:[\]%-]{1,512}$/u.test(host) || host.startsWith("-")) throw new Error("ssh-host");
  if (host.includes("@") && host.slice(0, host.lastIndexOf("@")).includes(":")) throw new Error("ssh-host");
  if (args.length > 32) throw new Error("ssh-args");
  return { host, args };
}

export function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let word = "";
  let quote = "";
  let started = false;
  for (let index = 0; index < input.length; index++) {
    const character = input[index]!;
    if (character === "\\" && quote !== "'" && index + 1 < input.length && /[\s\\"']/u.test(input[index + 1]!)) {
      word += input[++index]; started = true; continue;
    }
    if (quote) { if (character === quote) quote = ""; else word += character; continue; }
    if (character === "'" || character === "\"") { quote = character; started = true; continue; }
    if (/\s/u.test(character)) { if (started) tokens.push(word); word = ""; started = false; continue; }
    word += character; started = true;
  }
  if (quote) throw new Error("ssh-quote");
  if (started) tokens.push(word);
  return tokens;
}

export function sshCommonArgs(userArgs: string[]): string[] {
  return [
    "-T", ...userArgs,
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=5",
    "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=2",
    "-o", "RemoteCommand=none",
    "-o", "RequestTTY=no",
    "-o", "PermitLocalCommand=no"
  ];
}

export function minimalSshEnvironment(home: string): NodeJS.ProcessEnv {
  return {
    HOME: home,
    PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
    SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK,
    LANG: process.env.LANG ?? "C",
    LC_ALL: "C"
  };
}

export async function readProcessOutput(source: OpenCodeProcess["stdout"], maximum: number): Promise<string> {
  if (typeof source === "string") {
    if (Buffer.byteLength(source) > maximum) throw new Error("process-output");
    return source;
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of source) {
    const buffer = Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > maximum) throw new Error("process-output");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

export async function spawnProcess(command: string, args: string[], options: { env: NodeJS.ProcessEnv; detached: boolean }): Promise<OpenCodeProcess> {
  const child = nodeSpawn(command, args, {
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    env: options.env,
    detached: options.detached,
    windowsHide: true
  }) as ChildProcessWithoutNullStreams;
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  return {
    pid: child.pid!,
    stdout: child.stdout,
    stderr: child.stderr,
    exited: new Promise((resolve) => child.once("close", resolve)),
    write: (data) => { child.stdin.write(data); },
    end: () => { child.stdin.end(); },
    kill: (signal) => { child.kill(signal); }
  };
}

export async function reserveLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

export async function waitForLoopbackPort(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ready = await new Promise<boolean>((resolve) => {
      const socket = connect({ host: "127.0.0.1", port });
      socket.setTimeout(100);
      socket.once("connect", () => { socket.destroy(); resolve(true); });
      socket.once("error", () => resolve(false));
      socket.once("timeout", () => { socket.destroy(); resolve(false); });
    });
    if (ready) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

export async function terminateProcessGroup(child: OpenCodeProcess): Promise<void> {
  try {
    if (process.platform !== "win32") process.kill(-child.pid, "SIGTERM");
    else child.kill("SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  await Promise.race([child.exited, new Promise((resolve) => setTimeout(resolve, 500))]);
  try {
    if (process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
    else child.kill("SIGKILL");
  } catch {
    // The process group already exited.
  }
}
