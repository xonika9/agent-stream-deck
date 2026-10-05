import assert from "node:assert/strict";
import { mkdir, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { deflateRawSync } from "node:zlib";
import { fileURLToPath } from "node:url";

const auditScript = fileURLToPath(new URL("../scripts/audit-release.mjs", import.meta.url));

function crc32(contents: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of contents) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function buildZip(entries: Array<[string, string]>, comment = Buffer.alloc(0), method = 0): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localOffset = 0;
  for (const [name, value] of entries) {
    const nameBytes = Buffer.from(name);
    const contents = Buffer.from(value);
    const compressed = method === 8 ? deflateRawSync(contents) : contents;
    const local = Buffer.alloc(30);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc32(contents), 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(contents.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    localParts.push(local, nameBytes, compressed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc32(contents), 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(contents.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(localOffset, 42);
    centralParts.push(central, nameBytes);
    localOffset += local.length + nameBytes.length + compressed.length;
  }
  const centralSize = centralParts.reduce((size, part) => size + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(localOffset, 16);
  end.writeUInt16LE(comment.length, 20);
  return Buffer.concat([...localParts, ...centralParts, end, comment]);
}

test("release audit accepts explicit clean roots and rejects private state", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-deck-audit-"));
  try {
    const clean = join(root, "clean");
    await mkdir(clean);
    await writeFile(join(clean, "README.txt"), "public release fixture\n", "utf8");
    const cleanResult = spawnSync(process.execPath, [auditScript, clean], { encoding: "utf8" });
    assert.equal(cleanResult.status, 0, cleanResult.stderr);
    assert.match(cleanResult.stdout, /passed for 1 artifact roots/);

    await writeFile(join(clean, "watcher-ready.json"), "{}\n", "utf8");
    const privateResult = spawnSync(process.execPath, [auditScript, clean], { encoding: "utf8" });
    assert.equal(privateResult.status, 1);
    assert.match(privateResult.stderr, /private runtime state must not be packaged/);

    await rm(join(clean, "watcher-ready.json"));
    await writeFile(join(clean, "._manifest.json"), "local metadata\n", "utf8");
    const metadataResult = spawnSync(process.execPath, [auditScript, clean], { encoding: "utf8" });
    assert.equal(metadataResult.status, 1);
    assert.match(metadataResult.stderr, /platform metadata must not be packaged/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("release audit inspects supported archives and rejects unsafe entry paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-deck-archive-audit-"));
  try {
    const archive = join(root, "release.zip");
    await writeFile(archive, buildZip([["bundle/relay-client.json", "{}\n"]]));
    const privateResult = spawnSync(process.execPath, [auditScript, archive], { encoding: "utf8" });
    assert.equal(privateResult.status, 1);
    assert.match(privateResult.stderr, /private runtime state must not be packaged/);
    assert.match(privateResult.stderr, /release\.zip!\/bundle\/relay-client\.json/);

    await writeFile(archive, buildZip([["../relay-client.json", "{}\n"]]));
    const traversalResult = spawnSync(process.execPath, [auditScript, archive], { encoding: "utf8" });
    assert.equal(traversalResult.status, 1);
    assert.match(traversalResult.stderr, /unsafe archive entry path/);

    const plugin = join(root, "clean.streamDeckPlugin");
    await writeFile(plugin, buildZip([["plugin/manifest.json", '{"Name":"Public"}\n']]));
    const cleanResult = spawnSync(process.execPath, [auditScript, plugin], { encoding: "utf8" });
    assert.equal(cleanResult.status, 0, cleanResult.stderr);

    const corrupt = buildZip([["plugin/manifest.json", '{"Name":"Public"}\n']]);
    const payloadOffset = 30 + Buffer.byteLength("plugin/manifest.json");
    corrupt[payloadOffset] = corrupt[payloadOffset]! ^ 0xff;
    await writeFile(plugin, corrupt);
    const corruptResult = spawnSync(process.execPath, [auditScript, plugin], { encoding: "utf8" });
    assert.equal(corruptResult.status, 1);
    assert.match(corruptResult.stderr, /CRC-32 mismatch/);

    const falseEndSignature = Buffer.alloc(30);
    falseEndSignature.writeUInt32LE(0x06054b50, 0);
    await writeFile(plugin, buildZip([["plugin/manifest.json", "{}\n"]], falseEndSignature));
    const commentResult = spawnSync(process.execPath, [auditScript, plugin], { encoding: "utf8" });
    assert.equal(commentResult.status, 0, commentResult.stderr);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Independent archive boundary: real method-8 bytes and sparse oversized input.
test("release audit handles deflated CRC integrity and rejects oversized input before reading it", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-deflated-audit-"));
  try {
    const archive = join(root, "deflated.zip");
    const clean = buildZip([["public.txt", "public compressed content"]], Buffer.alloc(0), 8);
    await writeFile(archive, clean);
    assert.equal(spawnSync(process.execPath, [auditScript, archive], { encoding: "utf8" }).status, 0);
    const central = clean.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    clean.writeUInt32LE(0, central + 16);
    await writeFile(archive, clean);
    const corrupt = spawnSync(process.execPath, [auditScript, archive], { encoding: "utf8" });
    assert.equal(corrupt.status, 1);
    assert.match(corrupt.stderr, /CRC-32 mismatch/);
    const handle = await open(archive, "w");
    await handle.truncate(512 * 1024 * 1024 + 1);
    await handle.close();
    // A 64 MiB V8 heap is adequate for rejection; the old reader allocates the
    // entire sparse file as external memory. Resource usage measures that leak.
    const oversized = spawnSync(
      process.execPath,
      [
        "--max-old-space-size=64",
        "--import",
        "data:text/javascript,process.on('exit',()=>console.error('MAX_RSS='+process.resourceUsage().maxRSS))",
        auditScript,
        archive,
      ],
      {
        encoding: "utf8",
      },
    );
    assert.equal(oversized.status, 1);
    assert.match(oversized.stderr, /archive exceeds 536870912 bytes/);
    assert.ok(Number(oversized.stderr.match(/MAX_RSS=(\d+)/)?.[1]) < 128 * 1024, oversized.stderr);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
