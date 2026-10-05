import type { Registration, SshServer } from "./contracts.js";
import { MAX_SSH_SERVERS } from "./limits.js";
import { isRecord, boundedString, positiveInteger } from "./validation.js";

export function parseRegistration(bytes: Buffer, remote = false): Registration | null {
  let value: unknown;
  try { value = JSON.parse(bytes.toString("utf8")); } catch { return null; }
  if (!isRecord(value) || (value.id !== undefined && !boundedString(value.id, 256)) ||
    !boundedString(value.url, 2048) || !boundedString(value.password, 1024) || value.password.length === 0 ||
    // biome-ignore lint/suspicious/noControlCharactersInRegex: Reject or strip untrusted control characters deliberately.
    !boundedString(value.version, 64) || value.version.length === 0 || /[\u0000-\u001f\u007f]/u.test(value.version) ||
    !positiveInteger(value.pid)) return null;
  try { loopbackAddress(value.url, remote); } catch { return null; }
  return { id: value.id as string | undefined, url: value.url, password: value.password, version: value.version, pid: value.pid };
}

export function parseRemoteRegistration(output: string): Registration | null {
  const status = output.split(/\r?\n/u)
    .find((line) => line.startsWith("OPENCODE_SERVICE_STATUS="))
    ?.slice("OPENCODE_SERVICE_STATUS=".length);
  if (!status || status === "stopped") return null;
  const expression = /OPENCODE_REGISTRATION_BEGIN\r?\n([\s\S]*?)\r?\nOPENCODE_REGISTRATION_END/gu;
  for (const match of output.matchAll(expression)) {
    const parsed = parseRegistration(Buffer.from(match[1] ?? ""), true);
    if (parsed?.url === status) return parsed;
  }
  const pairOutput = remoteBlock(output, "OPENCODE_PAIR", 32 * 1024);
  const pairStatus = remoteBlock(output, "OPENCODE_PAIR_STATUS", 65_536);
  if (!pairOutput || !pairStatus) return null;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Reject or strip untrusted control characters deliberately.
  const cleanPairOutput = pairOutput.replace(/\u001b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/gu, "");
  const pairPassword = cleanPairOutput.match(/^\s*Password\s+([A-Za-z0-9._~+/=-]{1,1024})\s*$/mu)?.[1];
  if (!pairPassword) return null;
  let identity: unknown;
  try { identity = JSON.parse(pairStatus); } catch { return null; }
  if (!isRecord(identity) || !boundedString(identity.version, 64) || identity.version.length === 0 ||
    !positiveInteger(identity.pid)) return null;
  return parseRegistration(Buffer.from(JSON.stringify({
    url: status,
    password: pairPassword,
    version: identity.version,
    pid: identity.pid
  })), true);
}

export function remoteBlock(output: string, name: string, maximumBytes: number): string | null {
  const normalized = output.replace(/\r\n/gu, "\n");
  const opening = `${name}_BEGIN\n`;
  const closing = `\n${name}_END`;
  const start = normalized.indexOf(opening);
  if (start < 0 || normalized.indexOf(opening, start + opening.length) >= 0) return null;
  const contentStart = start + opening.length;
  const end = normalized.indexOf(closing, contentStart);
  if (end < 0 || normalized.indexOf(closing, end + closing.length) >= 0) return null;
  const content = normalized.slice(contentStart, end);
  return Buffer.byteLength(content, "utf8") <= maximumBytes ? content : null;
}

export function parseSshServers(bytes: Buffer): SshServer[] {
  const value = JSON.parse(bytes.toString("utf8")) as unknown;
  if (!isRecord(value)) throw new Error("settings-shape");
  const raw = value["ssh.servers"];
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > MAX_SSH_SERVERS) throw new Error("ssh-shape");
  return raw.map((item) => {
    if (!isRecord(item) || !boundedString(item.id, 256) || !boundedString(item.target, 2048) ||
      !boundedString(item.name, 256) || item.id.length === 0 || item.target.length === 0) throw new Error("ssh-entry");
    return { id: item.id, target: item.target, name: item.name };
  });
}

export function loopbackAddress(input: string, remote = false): { host: string; port: number } {
  const url = new URL(input);
  const allowedHosts = remote
    ? new Set(["127.0.0.1", "localhost", "0.0.0.0", "[::]", "[::1]"])
    : new Set(["127.0.0.1", "[::1]"]);
  if (url.protocol !== "http:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash ||
    !allowedHosts.has(url.hostname) || !url.port) throw new Error("origin");
  const port = Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("port");
  return { host: url.hostname === "[::]" || url.hostname === "[::1]" ? "[::1]" : "127.0.0.1", port };
}

