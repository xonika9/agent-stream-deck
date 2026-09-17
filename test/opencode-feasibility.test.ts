import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  NATIVE_SQLITE_TARGETS,
  probeReadonlyWal,
  resolveNativeSqliteTarget,
  verifyLoadedNativeSqlite
} from "../scripts/opencode-feasibility/native-sqlite.js";

test("declares every supported desktop runtime target", () => {
  assert.deepEqual(
    NATIVE_SQLITE_TARGETS.map(({ platform, arch }) => `${platform}-${arch}`),
    ["darwin-arm64", "darwin-x64", "win32-x64"]
  );
});

test("accepts supported Node 20 and newer runtimes", () => {
  assert.equal(resolveNativeSqliteTarget("darwin", "arm64", "20.17.0").platform, "darwin");
  assert.equal(resolveNativeSqliteTarget("win32", "x64", "24.0.0").arch, "x64");
  assert.throws(() => resolveNativeSqliteTarget("darwin", "arm64", "20.16.0"), /Node 20\.17\.0/);
  assert.throws(() => resolveNativeSqliteTarget("win32", "arm64", "24.0.0"), /Unsupported/);
});

test("loads SQLite, observes committed WAL data, and reports source-file effects", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-deck-sqlite-probe-"));
  try {
    const result = await probeReadonlyWal(directory);
    assert.deepEqual(result.rows, [{ value: "from-wal" }]);
    assert.equal(result.createdByReader.length, 0);
    assert.ok(result.filesChangedByReader.every((name) => name === "probe.sqlite-shm"));
    context.diagnostic(`read effects: ${result.filesChangedByReader.join(",") || "none"}`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("loads the exact pinned native SQLite binary", async () => {
  const target = resolveNativeSqliteTarget(process.platform, process.arch);
  const loaded = await verifyLoadedNativeSqlite();
  assert.equal(loaded.sha256, target.binarySha256);
  assert.match(loaded.path, /node_sqlite3\.node$/u);
});

test("probe artifacts and emitted result contain no absolute working path", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-deck-sqlite-probe-"));
  try {
    const result = await probeReadonlyWal(directory);
    const entries = await readdir(directory);
    const marker = Buffer.from(directory, "utf8");
    const wideMarker = Buffer.from(directory, "utf16le");
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes(directory), false);
    assert.equal(serialized.includes(JSON.stringify(directory).slice(1, -1)), false);
    for (const entry of entries) {
      const content = await readFile(join(directory, entry));
      assert.equal(content.includes(marker), false);
      assert.equal(content.includes(wideMarker), false);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
