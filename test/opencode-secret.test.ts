import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getOrCreateOpenCodeIdentitySecret } from "#opencode";

test("creates and reuses a user-only OpenCode identity secret", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-deck-secret-"));
  try {
    const first = await getOrCreateOpenCodeIdentitySecret(root);
    const second = await getOrCreateOpenCodeIdentitySecret(root);
    assert.equal(first.length, 32);
    assert.deepEqual(first, second);
    assert.deepEqual(await readFile(join(root, "opencode-identity.key")), first);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects broad permissions and symlinks", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-deck-secret-"));
  try {
    const path = join(root, "opencode-identity.key");
    await getOrCreateOpenCodeIdentitySecret(root);
    await chmod(path, 0o644);
    await assert.rejects(() => getOrCreateOpenCodeIdentitySecret(root), /unsafe/u);
    await rm(path);
    await symlink(join(root, "missing"), path);
    await assert.rejects(() => getOrCreateOpenCodeIdentitySecret(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
