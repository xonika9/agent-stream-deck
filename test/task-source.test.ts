import assert from "node:assert/strict";
import test from "node:test";
import { parseTaskSource, selectTaskCandidates, shouldCollectOpenCode, usesActiveQueue } from "#agents";

test("task source defaults upgrades and invalid values to Codex", () => {
  assert.equal(parseTaskSource(undefined), "Codex");
  assert.equal(parseTaskSource("unexpected"), "Codex");
  assert.equal(parseTaskSource("OpenCode"), "OpenCode");
  assert.equal(parseTaskSource("Both"), "All");
  assert.equal(parseTaskSource("T3 Code"), "T3 Code");
  assert.equal(parseTaskSource("All"), "All");
});

test("External sources force the queue without changing the Codex preference", () => {
  assert.equal(usesActiveQueue("Codex", false), false);
  assert.equal(usesActiveQueue("Codex", true), true);
  assert.equal(usesActiveQueue("OpenCode", false), true);
  assert.equal(usesActiveQueue("All", false), true);
});

test("task candidates are filtered before the shared queue projection", () => {
  assert.deepEqual(selectTaskCandidates("Codex", ["c"], ["o"]), ["c"]);
  assert.deepEqual(selectTaskCandidates("OpenCode", ["c"], ["o"]), ["o"]);
  assert.deepEqual(selectTaskCandidates(parseTaskSource("Both"), ["c"], ["o"], ["t"]), ["c", "o", "t"]);
  assert.deepEqual(selectTaskCandidates("T3 Code", ["c"], ["o"], ["t"]), ["t"]);
  assert.deepEqual(selectTaskCandidates("All", ["c"], ["o"], ["t"]), ["c", "o", "t"]);
});

test("OpenCode collection is opt-in and limited to the characterized macOS path", () => {
  assert.equal(shouldCollectOpenCode("Codex", "darwin"), false);
  assert.equal(shouldCollectOpenCode("OpenCode", "darwin"), true);
  assert.equal(shouldCollectOpenCode(parseTaskSource("Both"), "darwin"), true);
  assert.equal(shouldCollectOpenCode("OpenCode", "win32"), false);
  assert.equal(shouldCollectOpenCode("T3 Code", "darwin"), false);
  assert.equal(shouldCollectOpenCode("All", "darwin"), true);
});
