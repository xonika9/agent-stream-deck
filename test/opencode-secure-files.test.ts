import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { nodeOpenCodeFileAccess } from "#opencode";

test("service secrets require private mode while Desktop settings may be owner-write-only", {
  skip: process.platform === "win32"
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-files-"));
  const path = join(root, "settings");
  try {
    await writeFile(path, "fixture", { mode: 0o644 });
    await assert.rejects(() => nodeOpenCodeFileAccess.readSecure(path, 1024, process.getuid?.()));
    assert.equal(
      (await nodeOpenCodeFileAccess.readSecure(path, 1024, process.getuid?.(), "owner-write")).toString(),
      "fixture"
    );
    await chmod(path, 0o666);
    await assert.rejects(() => nodeOpenCodeFileAccess.readSecure(path, 1024, process.getuid?.(), "owner-write"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
