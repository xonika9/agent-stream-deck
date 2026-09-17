import assert from "node:assert/strict";
import test from "node:test";
import { foregroundOpenCode } from "../src/opencode-open.js";

test("foregrounds OpenCode Desktop by bundle id without a shell", async () => {
  const calls: Array<{ file: string; args: readonly string[] }> = [];
  await foregroundOpenCode("darwin", async (file, args) => { calls.push({ file, args }); });
  assert.deepEqual(calls, [{ file: "/usr/bin/open", args: ["-b", "ai.opencode.desktop"] }]);
});

test("fails closed on an uncharacterized platform", async () => {
  await assert.rejects(() => foregroundOpenCode("win32", async () => {}), /only on the characterized Mac/u);
});
