import assert from "node:assert/strict";
import test from "node:test";
import { readShell } from "../src/t3code/shell-reader.js";

async function* chunks(text: string, size = 65_536) {
  const bytes = Buffer.from(text);
  for (let offset = 0; offset < bytes.length; offset += size) yield bytes.subarray(offset, offset + size);
}

test("shell records survive splits inside UTF-8, JSON escapes, numbers and nested metadata", async () => {
  const payload = JSON.stringify({
    projects: [{ nested: { threads: [null, 2.5e25, true], text: '\\" } ]' } }],
    threads: [
      { id: "old", title: "Old", status: "idle" },
      { id: "active", title: 'Задача 😀 ["{}"]', status: "running", extra: { nested: [null, false] } },
    ],
    snapshotSequence: 2.5e25,
    schemaVersion: 2,
  });
  for (const size of [1, 7, 65_536]) {
    assert.deepEqual(await readShell(chunks(payload, size), (thread) => thread.status === "running"), {
      schemaVersion: 2,
      threads: [{ id: "active", title: 'Задача 😀 ["{}"]', status: "running", extra: { nested: [null, false] } }],
    });
  }
});

test("shell reader rejects incomplete, ambiguous and malformed snapshots", async () => {
  for (const payload of [
    '{"schemaVersion":2}',
    '{"threads":[]}',
    '{"schemaVersion":2,"threads":[],"threads":[]}',
    '{"schemaVersion":2,"threads":{}}',
    '{"schemaVersion":2,"threads":[null]}',
    '{"schemaVersion":2,"threads":[{},]}',
    '{"schemaVersion":2,"threads":[],}',
    '{"schemaVersion":2,"threads":[],"extra":{"bad":]}',
    '{"schemaVersion":2,"threads":[{}]',
    '{"schemaVersion":2,"threads":[]}false',
    '{"schemaVersion":2,\u00a0"threads":[]}',
  ]) {
    await assert.rejects(
      readShell(chunks(payload, 7), () => true),
      payload,
    );
  }
});

test("shell reader bounds individual records, nesting and retained tasks", async () => {
  await assert.rejects(
    readShell(chunks(JSON.stringify({ schemaVersion: 2, threads: [{ title: "x".repeat(262_144) }] })), () => false),
    /record too large/u,
  );
  const nested = `${"[".repeat(65)}0${"]".repeat(65)}`;
  await assert.rejects(
    readShell(chunks(`{"schemaVersion":2,"threads":[],"projects":[${nested}]}`, 7), () => false),
    /record too deep/u,
  );
  await assert.rejects(
    readShell(
      chunks(JSON.stringify({ schemaVersion: 2, threads: Array.from({ length: 10_001 }, () => ({})) })),
      () => true,
    ),
    /Too many active threads/u,
  );
  await assert.rejects(
    readShell(
      chunks(
        JSON.stringify({
          schemaVersion: 2,
          threads: Array.from({ length: 40 }, () => ({ title: "x".repeat(250_000) })),
        }),
      ),
      () => true,
    ),
    /Active threads too large/u,
  );
});
