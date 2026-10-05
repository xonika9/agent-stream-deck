import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
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

function storedZip(entries: Array<[string, string]>, comment = Buffer.alloc(0)): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localOffset = 0;
  for (const [name, value] of entries) {
    const nameBytes = Buffer.from(name);
    const contents = Buffer.from(value);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc32(contents), 14);
    local.writeUInt32LE(contents.length, 18);
    local.writeUInt32LE(contents.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    localParts.push(local, nameBytes, contents);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc32(contents), 16);
    central.writeUInt32LE(contents.length, 20);
    central.writeUInt32LE(contents.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(localOffset, 42);
    centralParts.push(central, nameBytes);
    localOffset += local.length + nameBytes.length + contents.length;
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

    await writeFile(join(clean, "relay-client.json"), "{}\n", "utf8");
    const privateResult = spawnSync(process.execPath, [auditScript, clean], { encoding: "utf8" });
    assert.equal(privateResult.status, 1);
    assert.match(privateResult.stderr, /private runtime state must not be packaged/);

    await rm(join(clean, "relay-client.json"));
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
    await writeFile(archive, storedZip([["bundle/relay-client.json", "{}\n"]]));
    const privateResult = spawnSync(process.execPath, [auditScript, archive], { encoding: "utf8" });
    assert.equal(privateResult.status, 1);
    assert.match(privateResult.stderr, /private runtime state must not be packaged/);
    assert.match(privateResult.stderr, /release\.zip!\/bundle\/relay-client\.json/);

    await writeFile(archive, storedZip([["../relay-client.json", "{}\n"]]));
    const traversalResult = spawnSync(process.execPath, [auditScript, archive], { encoding: "utf8" });
    assert.equal(traversalResult.status, 1);
    assert.match(traversalResult.stderr, /unsafe archive entry path/);

    const plugin = join(root, "clean.streamDeckPlugin");
    await writeFile(plugin, storedZip([["plugin/manifest.json", '{"Name":"Public"}\n']]));
    const cleanResult = spawnSync(process.execPath, [auditScript, plugin], { encoding: "utf8" });
    assert.equal(cleanResult.status, 0, cleanResult.stderr);

    const corrupt = storedZip([["plugin/manifest.json", '{"Name":"Public"}\n']]);
    const payloadOffset = 30 + Buffer.byteLength("plugin/manifest.json");
    corrupt[payloadOffset] = corrupt[payloadOffset]! ^ 0xff;
    await writeFile(plugin, corrupt);
    const corruptResult = spawnSync(process.execPath, [auditScript, plugin], { encoding: "utf8" });
    assert.equal(corruptResult.status, 1);
    assert.match(corruptResult.stderr, /CRC-32 mismatch/);

    const falseEndSignature = Buffer.alloc(30);
    falseEndSignature.writeUInt32LE(0x06054b50, 0);
    await writeFile(plugin, storedZip([["plugin/manifest.json", "{}\n"]], falseEndSignature));
    const commentResult = spawnSync(process.execPath, [auditScript, plugin], { encoding: "utf8" });
    assert.equal(commentResult.status, 0, commentResult.stderr);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
