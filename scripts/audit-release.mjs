import { readFile, readdir, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, posix, resolve } from "node:path";
import { inflateRawSync } from "node:zlib";

const roots = process.argv.slice(2).length
  ? process.argv.slice(2).map((path) => resolve(path))
  : [
      resolve("com.xonika9.codex-deck.streamDeckPlugin"),
      resolve("release/codex-deck-launcher"),
      resolve("release/codex-deck-launcher-macos"),
    ];

const forbiddenFiles = new Set([
  "codex-micro-bridge.json",
  "control-target.json",
  "host.json",
  "relay-client.json",
  "relay-server.json",
  "mobile-relay-server.json",
  "mobile-local-relay-server.json",
  "mobile-local-pairing.svg",
  "relay-tunnel.pid",
  "watcher-state.json",
  "watcher.log",
  "watcher.log.1",
  "watcher.log.2",
  "watcher.log.3",
]);
const protectedKeycaps = new Set(
  "FAST APPR REJ SPLIT MIC CODEX BUG OAI TERM DWN DEL NEW NAV MAGIC DIFF PLAY GIT BRCH MRG PR PAINT LAB PARTY TIME MIND+ MIND- SETUP FOLD UPL APPS".split(
    " ",
  ),
);
const forbiddenText = [
  /[A-Z]:\\Users\\(?!Public\\|Default\\|tester\\)[^\\/\s]+/iu,
  /\/Users\/(?!Shared\/|tester\/)[^/\s]+/iu,
  /\b100\.(?:\d{1,3}\.){2}\d{1,3}\b(?!\/10)/u,
  ...String(process.env.CODEX_DECK_PRIVATE_MARKERS ?? "")
    .split("|")
    .filter(Boolean)
    .map((marker) => new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "iu")),
];
const textExtensions = new Set([
  ".cmd",
  ".command",
  ".html",
  ".js",
  ".json",
  ".map",
  ".md",
  ".mjs",
  ".ps1",
  ".sh",
  ".svg",
  ".txt",
]);
const archiveExtensions = new Set([".zip", ".streamdeckplugin"]);
const maxArchiveBytes = 512 * 1024 * 1024;
const maxEntryBytes = 64 * 1024 * 1024;
const maxTotalUncompressedBytes = 512 * 1024 * 1024;
const maxEntries = 20_000;
const failures = [];
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  return crc >>> 0;
});

function auditContents(path, contents) {
  const name = basename(path);
  if (name === ".DS_Store" || name.startsWith("._")) failures.push(`${path}: platform metadata must not be packaged`);
  if (forbiddenFiles.has(name.toLowerCase())) failures.push(`${path}: private runtime state must not be packaged`);
  if (extname(name).toLowerCase() === ".svg" && protectedKeycaps.has(name.slice(0, -4).toUpperCase())) {
    failures.push(`${path}: protected Codex keycap SVG must not be packaged`);
  }
  if (!contents || !textExtensions.has(extname(name).toLowerCase()) || contents.length > 8 * 1024 * 1024) return;
  const text = contents.toString("utf8");
  for (const pattern of forbiddenText)
    if (pattern.test(text)) failures.push(`${path}: contains private setup marker ${pattern}`);
}

function findEndOfCentralDirectory(archive) {
  const minimumOffset = Math.max(0, archive.length - 65_557);
  for (let offset = archive.length - 22; offset >= minimumOffset; offset -= 1) {
    if (archive.readUInt32LE(offset) !== 0x06054b50) continue;
    const disk = archive.readUInt16LE(offset + 4);
    const centralDisk = archive.readUInt16LE(offset + 6);
    const diskEntries = archive.readUInt16LE(offset + 8);
    const totalEntries = archive.readUInt16LE(offset + 10);
    const centralSize = archive.readUInt32LE(offset + 12);
    const centralOffset = archive.readUInt32LE(offset + 16);
    const commentLength = archive.readUInt16LE(offset + 20);
    if (offset + 22 + commentLength !== archive.length) continue;
    if (disk !== 0 || centralDisk !== 0 || diskEntries !== totalEntries) continue;
    if (centralOffset !== 0xffffffff && centralSize !== 0xffffffff && centralOffset + centralSize !== offset) continue;
    return offset;
  }
  throw new Error("ZIP end-of-central-directory record not found");
}

function crc32(contents) {
  let crc = 0xffffffff;
  for (const byte of contents) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function safeArchivePath(name) {
  const slashName = name.replaceAll("\\", "/");
  const normalized = posix.normalize(slashName);
  if (
    !name ||
    name.includes("\0") ||
    isAbsolute(slashName) ||
    /^[A-Za-z]:\//u.test(slashName) ||
    normalized === ".." ||
    normalized.startsWith("../")
  ) {
    throw new Error(`unsafe archive entry path: ${JSON.stringify(name)}`);
  }
  return normalized;
}

function zip64Values(extra, fields) {
  let offset = 0;
  while (offset + 4 <= extra.length) {
    const id = extra.readUInt16LE(offset);
    const size = extra.readUInt16LE(offset + 2);
    const end = offset + 4 + size;
    if (end > extra.length) throw new Error("invalid ZIP extra field bounds");
    if (id === 0x0001) {
      let valueOffset = offset + 4;
      const values = {};
      for (const field of fields) {
        if (valueOffset + 8 > end) throw new Error("incomplete ZIP64 extra field");
        const value = extra.readBigUInt64LE(valueOffset);
        if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("ZIP64 value exceeds the safe integer range");
        values[field] = Number(value);
        valueOffset += 8;
      }
      return values;
    }
    offset = end;
  }
  throw new Error("missing ZIP64 extra field");
}

function auditArchive(path, archive) {
  if (archive.length > maxArchiveBytes) throw new Error(`archive exceeds ${maxArchiveBytes} bytes`);
  const endOffset = findEndOfCentralDirectory(archive);
  const entryCount = archive.readUInt16LE(endOffset + 10);
  const centralSize = archive.readUInt32LE(endOffset + 12);
  const centralOffset = archive.readUInt32LE(endOffset + 16);
  if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff)
    throw new Error("ZIP64 archives are not supported");
  if (entryCount > maxEntries || centralOffset + centralSize !== endOffset)
    throw new Error("invalid ZIP central directory bounds");

  let offset = centralOffset;
  let declaredTotal = 0;
  let actualTotal = 0;
  for (let index = 0; index < entryCount; index += 1) {
    const entryOffset = offset;
    if (offset + 46 > archive.length || archive.readUInt32LE(offset) !== 0x02014b50)
      throw new Error("invalid ZIP central directory entry");
    const flags = archive.readUInt16LE(offset + 8);
    const method = archive.readUInt16LE(offset + 10);
    const expectedCrc = archive.readUInt32LE(offset + 16);
    let compressedSize = archive.readUInt32LE(offset + 20);
    let uncompressedSize = archive.readUInt32LE(offset + 24);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    let localOffset = archive.readUInt32LE(offset + 42);
    const nextOffset = offset + 46 + nameLength + extraLength + commentLength;
    if (nextOffset > archive.length) throw new Error("invalid ZIP entry bounds");
    const name = archive.subarray(offset + 46, offset + 46 + nameLength).toString(flags & 0x800 ? "utf8" : "latin1");
    const zip64Fields = [];
    if (uncompressedSize === 0xffffffff) zip64Fields.push("uncompressedSize");
    if (compressedSize === 0xffffffff) zip64Fields.push("compressedSize");
    if (localOffset === 0xffffffff) zip64Fields.push("localOffset");
    if (zip64Fields.length) {
      const extra = archive.subarray(offset + 46 + nameLength, offset + 46 + nameLength + extraLength);
      const values = zip64Values(extra, zip64Fields);
      if (values.uncompressedSize !== undefined) uncompressedSize = values.uncompressedSize;
      if (values.compressedSize !== undefined) compressedSize = values.compressedSize;
      if (values.localOffset !== undefined) localOffset = values.localOffset;
    }
    const safeName = safeArchivePath(name);
    offset = nextOffset;
    if ((flags & 1) !== 0) throw new Error(`${safeName}: encrypted ZIP entries are not supported`);
    if (compressedSize > maxArchiveBytes || uncompressedSize > maxEntryBytes)
      throw new Error(`${safeName}: ZIP entry is too large to audit safely`);
    declaredTotal += uncompressedSize;
    if (declaredTotal > maxTotalUncompressedBytes)
      throw new Error(`archive exceeds ${maxTotalUncompressedBytes} declared uncompressed bytes`);
    if (localOffset + 30 > archive.length || archive.readUInt32LE(localOffset) !== 0x04034b50)
      throw new Error(`${safeName}: invalid ZIP local header`);
    const localFlags = archive.readUInt16LE(localOffset + 6);
    const localMethod = archive.readUInt16LE(localOffset + 8);
    const localNameLength = archive.readUInt16LE(localOffset + 26);
    const localExtraLength = archive.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    if (dataOffset + compressedSize > archive.length) throw new Error(`${safeName}: invalid ZIP data bounds`);
    const localName = archive.subarray(localOffset + 30, localOffset + 30 + localNameLength);
    const centralName = archive.subarray(entryOffset + 46, entryOffset + 46 + nameLength);
    if (localFlags !== flags || localMethod !== method || !localName.equals(centralName))
      throw new Error(`${safeName}: ZIP local and central headers disagree`);
    const compressed = archive.subarray(dataOffset, dataOffset + compressedSize);
    const remainingBudget = maxTotalUncompressedBytes - actualTotal;
    const contents =
      method === 0
        ? compressed
        : method === 8
          ? inflateRawSync(compressed, { maxOutputLength: Math.min(maxEntryBytes, remainingBudget) })
          : null;
    if (!contents) throw new Error(`${safeName}: unsupported ZIP compression method ${method}`);
    if (contents.length !== uncompressedSize) throw new Error(`${safeName}: ZIP entry size mismatch`);
    actualTotal += contents.length;
    if (actualTotal > maxTotalUncompressedBytes)
      throw new Error(`archive exceeds ${maxTotalUncompressedBytes} actual uncompressed bytes`);
    if (crc32(contents) !== expectedCrc) throw new Error(`${safeName}: ZIP entry CRC-32 mismatch`);
    if (!safeName.endsWith("/")) auditContents(`${path}!/${safeName}`, contents);
  }
  if (offset !== centralOffset + centralSize) throw new Error("ZIP central directory size mismatch");
}

async function walk(path) {
  const info = await stat(path);
  if (info.isDirectory()) {
    for (const entry of await readdir(path)) await walk(resolve(path, entry));
    return;
  }
  const extension = extname(path).toLowerCase();
  if (archiveExtensions.has(extension)) {
    try {
      auditArchive(path, await readFile(path));
    } catch (error) {
      failures.push(`${path}: cannot audit archive (${String(error)})`);
    }
  }
  const contents = textExtensions.has(extension) && info.size <= 8 * 1024 * 1024 ? await readFile(path) : null;
  auditContents(path, contents);
}

for (const root of roots) {
  try {
    await walk(root);
  } catch (error) {
    failures.push(`${root}: cannot audit (${String(error)})`);
  }
}

if (failures.length) {
  console.error("Release audit failed:\n" + failures.map((failure) => `- ${failure}`).join("\n"));
  process.exit(1);
}
console.log(`Release audit passed for ${roots.length} artifact roots.`);
