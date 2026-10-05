import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, writeFile, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { T3CodeSource } from "#t3code";
import type { CodexHost } from "#agents";

const host: CodexHost = { hostId: "local", hostName: "Mac", platform: "darwin" };

test("authenticated T3 shell becomes a queue, acknowledges only the displayed revision and clears on failure", {
  skip: process.platform === "win32",
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "deck-t3-"));
  const now = Date.now();
  const iso = (n: number) => new Date(n).toISOString();
  const thread = (id: string, status: string, completedAt: number | null = null) => ({
    id,
    title: `Task ${id}`,
    projectId: "project",
    archivedAt: null,
    settledAt: null,
    status,
    latestRunRequestedAt: iso(now - 1000),
    activityRunStartedAt: iso(now - 1000),
    latestRunCompletedAt: completedAt ? iso(completedAt) : null,
    pendingRuntimeRequest: null,
    hasActionableProposedPlan: false,
  });
  const working = thread("Case", "running");
  const done = thread("case", "completed", now);
  const approval = { ...thread("approval", "waiting"), pendingRuntimeRequest: { kind: "approval" } };
  let payload = {
    schemaVersion: 2,
    threads: [
      working,
      done,
      approval,
      thread("failed", "failed", now),
      { ...thread("viewed", "completed", now), lastVisitedAt: iso(now) },
      thread("old", "completed", now - 600000),
    ],
  };
  let fail = false;
  let requests = 0;
  const server = createServer((req, res) => {
    requests++;
    assert.equal(req.headers.authorization, "Bearer fixture-token");
    assert.equal(req.url, "/api/orchestration/shell");
    assert.equal(req.headers["x-t3-orchestration-protocol"], "2");
    res.writeHead(fail ? 401 : 200, { "content-type": "application/json" });
    res.end(JSON.stringify(payload));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const configPath = join(root, "config.json");
  const runtimePath = join(root, "runtime.json");
  await writeFile(configPath, JSON.stringify({ origin, token: "fixture-token" }), { mode: 0o600 });
  await writeFile(runtimePath, JSON.stringify({ version: 1, pid: process.pid, origin, port: address.port }));
  let opened = 0;
  const source = new T3CodeSource(() => {}, {
    configPath,
    runtimePath,
    foreground: async () => {
      opened++;
    },
  });
  try {
    source.syncDemand("Codex", host, false);
    await source.refresh();
    assert.equal(requests, 0);
    source.syncDemand("T3 Code", host, false);
    await source.refresh();
    assert.equal(source.health.state, "ready");
    assert.deepEqual(
      source.slots.map((s) => [s.threadKey, s.status]),
      [
        ["Case", "working"],
        ["case", "unread"],
        ["approval", "approval"],
        ["failed", "error"],
      ],
    );
    const assignment = source.slots[1]!;
    assert.equal(await source.open(assignment, new AbortController().signal), true);
    assert.equal(opened, 1);
    assert.equal(
      source.slots.some((s) => s.threadKey === "case"),
      false,
    );
    done.latestRunCompletedAt = iso(now + 1);
    await source.refresh();
    assert.equal(
      source.slots.some((s) => s.threadKey === "case"),
      true,
    );
    assert.equal(await source.open(assignment, new AbortController().signal), false);
    assert.equal(
      source.slots.some((s) => s.threadKey === "case"),
      true,
    );
    payload = { schemaVersion: 2, threads: [working] };
    fail = true;
    await source.refresh();
    assert.equal(source.health.state, "degraded");
    assert.deepEqual(source.slots, []);
    fail = false;
    await chmod(configPath, 0o644);
    const protectedRequests = requests;
    await source.refresh();
    assert.equal(requests, protectedRequests);
    assert.equal(source.health.state, "degraded");
    await chmod(configPath, 0o600);
    await writeFile(configPath, JSON.stringify({ origin: "http://192.0.2.1:3773", token: "fixture-token" }));
    await source.refresh();
    assert.equal(requests, protectedRequests);
    assert.equal(source.health.state, "degraded");
    source.syncDemand("OpenCode", host, false);
    fail = false;
    const previous = requests;
    await source.refresh();
    assert.equal(requests, previous);
  } finally {
    source.stop();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
