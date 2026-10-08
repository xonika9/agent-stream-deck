import assert from "node:assert/strict";
import test from "node:test";
import { LocalActivityIndex } from "#agents";
import { createMicroSnapshot, host } from "./support/micro-snapshot.js";

const snapshot = createMicroSnapshot();

test("single-host agent modes preserve Codex's native six-slot order", () => {
  for (const mode of ["recent", "priority", "pinned", "custom"] as const) {
    const pinned = structuredClone(snapshot);
    pinned.agentSource = mode;
    for (const slot of pinned.slots) {
      slot.status = "idle";
      slot.selected = false;
      slot.activityAt = slot.id;
    }
    const merged = new LocalActivityIndex().merge({ host, snapshot: pinned, observedAt: 1_000 }, 1_000);
    assert.deepEqual(
      merged.map((slot) => slot.threadKey),
      pinned.slots.map((slot) => slot.threadKey),
    );
    assert.deepEqual(
      merged.map((slot) => slot.id),
      [0, 1, 2, 3, 4, 5],
    );
  }
});

test("tracked local catalog ownership keeps work-start metadata without lending it to temporary aliases", () => {
  const shared = "00000000-0000-4000-8000-000000000091";
  const input = { host, snapshot: structuredClone(snapshot), observedAt: 2_000 };
  input.snapshot.activeCatalog = {
    complete: true,
    candidates: [
      {
        threadKey: `remote:${shared}`,
        conversationId: shared,
        title: "Mirror",
        status: "working",
        selected: false,
        catalogIndex: 7,
        ownedByHost: false,
        workStartedAt: 1_999,
        workStartRevision: 99,
      },
      {
        threadKey: `local:${shared}`,
        conversationId: shared,
        title: null,
        status: "working",
        selected: false,
        catalogIndex: 129,
        ownedByHost: true,
        workStartedAt: 1_800,
        workStartRevision: 7,
      },
    ],
  };
  const match = new LocalActivityIndex().mergeActiveCatalog(input, 2_000)[0];
  assert.equal(match?.workStartedAt, 1_800);
  assert.equal(match?.workStartRevision, 7);
  input.snapshot.activeCatalog.candidates[1]!.threadKey = `local:client-new-thread:${shared}`;
  delete input.snapshot.activeCatalog.candidates[1]!.conversationId;
  const temporary = new LocalActivityIndex()
    .mergeActiveCatalog(input, 2_000)
    .find((slot) => slot.threadKey?.includes("client-new-thread"));
  assert.equal(temporary?.workStartedAt, undefined);
  assert.equal(temporary?.workStartRevision, undefined);
});

test("local catalog acknowledgement retains the viewed revision and admits a later completion", () => {
  const input = { host, snapshot: structuredClone(snapshot), observedAt: 2_000 };
  const threadId = input.snapshot.slots[1]!.threadKey!;
  input.snapshot.slots.forEach((slot) => {
    slot.selected = false;
    slot.status = "idle";
  });
  input.snapshot.hostSessions = [{ threadId, activityAt: 1_900, status: "complete", completionRevision: 10 }];
  const index = new LocalActivityIndex();
  const status = () =>
    index.mergeActiveCatalog(input, input.observedAt).find((slot) => slot.threadKey === threadId)?.status;
  assert.equal(status(), "complete");
  input.snapshot.activeThreadKey = threadId;
  assert.equal(status(), "idle");
  delete input.snapshot.activeThreadKey;
  assert.equal(status(), "idle");
  input.snapshot.hostSessions[0]!.completionRevision = 20;
  assert.equal(status(), "complete");
  input.snapshot.slots[1]!.status = "awaiting-approval";
  assert.equal(status(), "awaiting-approval");
  input.snapshot.slots[1]!.status = "idle";
  input.observedAt = 1_900 + 5 * 60_000 + 1;
  assert.equal(status(), "idle", "old session completion cannot resurrect a native idle slot");
});
