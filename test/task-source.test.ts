import assert from "node:assert/strict";
import test from "node:test";
import {
  legacyTaskSource,
  parseTaskSource,
  parseTaskSources,
  selectTaskCandidates,
  shouldCollectOpenCode,
  taskSourceNames,
  taskSourcesEqual,
  usesActiveQueue,
} from "#agents";

function sorted(sources: ReadonlySet<string>): string[] {
  return [...sources].sort();
}

test("legacy task source values upgrade to the matching source set", () => {
  assert.deepEqual(sorted(parseTaskSources(undefined)), ["Codex"]);
  assert.deepEqual(sorted(parseTaskSources({})), ["Codex"]);
  assert.deepEqual(sorted(parseTaskSources({ taskSource: "unexpected" })), ["Codex"]);
  assert.deepEqual(sorted(parseTaskSources({ taskSource: "Codex" })), ["Codex"]);
  assert.deepEqual(sorted(parseTaskSources({ taskSource: "OpenCode" })), ["OpenCode"]);
  assert.deepEqual(sorted(parseTaskSources({ taskSource: "T3 Code" })), ["T3 Code"]);
  assert.deepEqual(sorted(parseTaskSources({ taskSource: "Both" })), ["Codex", "OpenCode", "T3 Code"]);
  assert.deepEqual(sorted(parseTaskSources({ taskSource: "All" })), ["Codex", "OpenCode", "T3 Code"]);
});

test("the new task sources array wins over the legacy value, garbage means Codex only", () => {
  assert.deepEqual(sorted(parseTaskSources({ taskSources: ["OpenCode"] })), ["OpenCode"]);
  assert.deepEqual(sorted(parseTaskSources({ taskSources: ["Codex", "T3 Code"] })), ["Codex", "T3 Code"]);
  assert.deepEqual(sorted(parseTaskSources({ taskSources: ["T3 Code", "Codex", "OpenCode"] })), [
    "Codex",
    "OpenCode",
    "T3 Code",
  ]);
  assert.deepEqual(sorted(parseTaskSources({ taskSources: ["Codex", "Codex"] })), ["Codex"]);
  assert.deepEqual(sorted(parseTaskSources({ taskSources: ["Codex", "T3 Code"], taskSource: "OpenCode" })), [
    "Codex",
    "T3 Code",
  ]);
  assert.deepEqual(sorted(parseTaskSources({ taskSources: [] })), ["Codex"]);
  assert.deepEqual(sorted(parseTaskSources({ taskSources: ["bogus"] })), ["Codex"]);
  assert.deepEqual(sorted(parseTaskSources({ taskSources: "All" })), ["Codex"]);
});

test("the legacy single value is preserved for rollback", () => {
  assert.equal(parseTaskSource(undefined), "Codex");
  assert.equal(parseTaskSource("unexpected"), "Codex");
  assert.equal(parseTaskSource("Both"), "All");
  assert.equal(parseTaskSource("All"), "All");
  assert.equal(parseTaskSource("OpenCode"), "OpenCode");
  assert.equal(legacyTaskSource(parseTaskSources({ taskSource: "All" })), "All");
  assert.equal(legacyTaskSource(parseTaskSources({ taskSource: "Both" })), "All");
  assert.equal(legacyTaskSource(parseTaskSources({ taskSources: ["Codex", "T3 Code"] })), "All");
  assert.equal(legacyTaskSource(parseTaskSources({ taskSources: ["OpenCode"] })), "OpenCode");
  assert.equal(legacyTaskSource(parseTaskSources({ taskSources: [] })), "Codex");
});

test("source sets keep a canonical order and compare by members", () => {
  assert.deepEqual(taskSourceNames(parseTaskSources({ taskSource: "All" })), ["Codex", "OpenCode", "T3 Code"]);
  assert.deepEqual(taskSourceNames(parseTaskSources({ taskSources: ["T3 Code", "Codex"] })), ["Codex", "T3 Code"]);
  assert.equal(
    taskSourcesEqual(
      parseTaskSources({ taskSource: "All" }),
      parseTaskSources({ taskSources: ["T3 Code", "Codex", "OpenCode"] }),
    ),
    true,
  );
  assert.equal(
    taskSourcesEqual(parseTaskSources({ taskSource: "Codex" }), parseTaskSources({ taskSource: "OpenCode" })),
    false,
  );
});

test("the queue is forced unless the set is Codex only", () => {
  assert.equal(usesActiveQueue(parseTaskSources({ taskSource: "Codex" }), false), false);
  assert.equal(usesActiveQueue(parseTaskSources({ taskSource: "Codex" }), true), true);
  assert.equal(usesActiveQueue(parseTaskSources({ taskSource: "OpenCode" }), false), true);
  assert.equal(usesActiveQueue(parseTaskSources({ taskSource: "T3 Code" }), true), true);
  assert.equal(usesActiveQueue(parseTaskSources({ taskSource: "All" }), false), true);
  assert.equal(usesActiveQueue(parseTaskSources({ taskSources: ["Codex", "T3 Code"] }), false), true);
  assert.equal(usesActiveQueue(parseTaskSources({ taskSources: [] }), false), false);
});

test("task candidates are filtered before the shared queue projection", () => {
  assert.deepEqual(selectTaskCandidates(parseTaskSources({ taskSource: "Codex" }), ["c"], ["o"]), ["c"]);
  assert.deepEqual(selectTaskCandidates(parseTaskSources({ taskSource: "OpenCode" }), ["c"], ["o"]), ["o"]);
  assert.deepEqual(selectTaskCandidates(parseTaskSources({ taskSource: "Both" }), ["c"], ["o"], ["t"]), [
    "c",
    "o",
    "t",
  ]);
  assert.deepEqual(selectTaskCandidates(parseTaskSources({ taskSource: "T3 Code" }), ["c"], ["o"], ["t"]), ["t"]);
  assert.deepEqual(selectTaskCandidates(parseTaskSources({ taskSource: "All" }), ["c"], ["o"], ["t"]), ["c", "o", "t"]);
  assert.deepEqual(selectTaskCandidates(parseTaskSources({ taskSources: ["Codex", "T3 Code"] }), ["c"], ["o"], ["t"]), [
    "c",
    "t",
  ]);
  assert.deepEqual(selectTaskCandidates(parseTaskSources({ taskSources: [] }), ["c"], ["o"], ["t"]), ["c"]);
  assert.deepEqual(
    selectTaskCandidates(parseTaskSources({ taskSources: ["Codex", "OpenCode", "T3 Code"] }), ["c"], ["o"], ["t"]),
    ["c", "o", "t"],
  );
});

test("OpenCode collection is opt-in and limited to the characterized macOS path", () => {
  assert.equal(shouldCollectOpenCode(parseTaskSources({ taskSource: "Codex" }), "darwin"), false);
  assert.equal(shouldCollectOpenCode(parseTaskSources({ taskSource: "OpenCode" }), "darwin"), true);
  assert.equal(shouldCollectOpenCode(parseTaskSources({ taskSource: "Both" }), "darwin"), true);
  assert.equal(shouldCollectOpenCode(parseTaskSources({ taskSource: "OpenCode" }), "win32"), false);
  assert.equal(shouldCollectOpenCode(parseTaskSources({ taskSource: "T3 Code" }), "darwin"), false);
  assert.equal(shouldCollectOpenCode(parseTaskSources({ taskSource: "All" }), "darwin"), true);
  assert.equal(shouldCollectOpenCode(parseTaskSources({ taskSources: ["Codex", "T3 Code"] }), "darwin"), false);
  assert.equal(shouldCollectOpenCode(parseTaskSources({ taskSources: ["Codex", "OpenCode"] }), "darwin"), true);
});
