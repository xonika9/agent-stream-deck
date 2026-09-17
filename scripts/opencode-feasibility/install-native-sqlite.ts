import { createHash } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";
import {
  NATIVE_SQLITE_VERSION,
  resolveNativeSqliteTarget
} from "./native-sqlite.js";

const MAX_ARCHIVE_BYTES = 4 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES = 8 * 1024 * 1024;
const EXPECTED_ENTRY = "build/Release/node_sqlite3.node";

async function download(url: string): Promise<Buffer> {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || !response.body) throw new Error(`SQLite archive download failed with HTTP ${response.status}.`);
  if (new URL(response.url).protocol !== "https:") throw new Error("SQLite archive redirected away from HTTPS.");
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_ARCHIVE_BYTES) throw new Error("SQLite archive exceeds the byte limit.");
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of response.body) {
    const buffer = Buffer.from(chunk);
    length += buffer.length;
    if (length > MAX_ARCHIVE_BYTES) throw new Error("SQLite archive exceeds the byte limit.");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function parseOctal(input: Buffer): number {
  const text = input.toString("ascii").replaceAll("\0", "").trim();
  if (!/^[0-7]+$/u.test(text)) throw new Error("SQLite archive has an invalid tar size.");
  return Number.parseInt(text, 8);
}

function extractOnlyNativeBinary(archive: Buffer): Buffer {
  const tar = gunzipSync(archive, { maxOutputLength: MAX_UNCOMPRESSED_BYTES });
  let offset = 0;
  let found: Buffer | undefined;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/u, "");
    const size = parseOctal(header.subarray(124, 136));
    const type = header[156] ?? 0;
    const start = offset + 512;
    const end = start + size;
    if (end > tar.length) throw new Error("SQLite archive entry is truncated.");
    if (type === 0 || type === 48) {
      if (name !== EXPECTED_ENTRY || found) throw new Error("SQLite archive contains an unexpected file.");
      found = Buffer.from(tar.subarray(start, end));
    } else if (type !== 53) {
      throw new Error("SQLite archive contains an unsupported entry type.");
    }
    offset = start + Math.ceil(size / 512) * 512;
  }
  if (!found) throw new Error("SQLite archive does not contain the native binary.");
  return found;
}

const target = resolveNativeSqliteTarget(process.platform, process.arch);
const url = `https://github.com/TryGhost/node-sqlite3/releases/download/v${NATIVE_SQLITE_VERSION}/${target.archive}`;
const archive = await download(url);
const archiveSha256 = createHash("sha256").update(archive).digest("hex");
if (archiveSha256 !== target.archiveSha256) throw new Error("SQLite archive does not match the pinned hash.");
const binary = extractOnlyNativeBinary(archive);
const binarySha256 = createHash("sha256").update(binary).digest("hex");
if (binarySha256 !== target.binarySha256) throw new Error("SQLite binary does not match the pinned hash.");

const require = createRequire(import.meta.url);
const packageRoot = dirname(require.resolve("sqlite3/package.json"));
const destination = join(packageRoot, EXPECTED_ENTRY);
const temporary = `${destination}.${process.pid}.tmp`;
await mkdir(dirname(destination), { recursive: true });
await writeFile(temporary, binary, { mode: 0o755, flag: "wx" });
try {
  await rename(temporary, destination);
} finally {
  await rm(temporary, { force: true });
}
console.log(`Verified sqlite3 ${NATIVE_SQLITE_VERSION} for ${target.platform}-${target.arch}.`);
