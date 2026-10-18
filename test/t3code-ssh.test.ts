import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { t3SshRequest } from "#t3code";
import { REMOTE_SHELL_READER } from "../src/t3code/remote-shell.js";

test("remote Python reader filters growing history before SSH and fails closed on invalid snapshots", {
  skip: process.platform === "win32",
}, async (context) => {
  const root = await mkdtemp(join(tmpdir(), "deck-t3-python-"));
  const now = Date.now();
  const iso = (offset = 0) => new Date(now + offset).toISOString();
  const thread = (id: string, status: string, extra = {}) => ({ id, title: 'Задача 😀 ["{}"]', status, ...extra });
  const working = thread("working", "running", { privateMetadata: "must-not-cross-ssh" });
  const active = [
    working,
    thread("approval", "idle", { pendingRuntimeRequest: {} }),
    thread("background", "completed", { pendingBackgroundTasks: [{}] }),
    thread("done", "completed", { latestRunCompletedAt: iso() }),
    thread("failed", "failed", { latestRunCompletedAt: iso() }),
  ];
  const ignored = [
    thread("archived", "running", { archivedAt: iso() }),
    thread("settled", "running", { settledOverride: "settled" }),
    thread("snoozed", "running", { snoozedUntil: iso(60_000) }),
    thread("viewed", "completed", { latestRunCompletedAt: iso(), lastVisitedAt: iso() }),
  ];
  const history = Array.from({ length: 12_000 }, () =>
    thread("old", "completed", { latestRunCompletedAt: iso(-600_000), lineage: "x".repeat(800) }),
  );
  let payload = JSON.stringify({ schemaVersion: 2, threads: [...history, ...ignored, ...active] });
  assert.ok(Buffer.byteLength(payload) > 8 * 1024 * 1024);
  let status = 200;
  const server = createServer((request, response) => {
    assert.equal(request.url, "/api/orchestration/shell");
    assert.equal(request.headers.authorization, "Bearer fixture-token");
    assert.equal(request.headers["x-t3-orchestration-protocol"], "2");
    response.writeHead(status, { "content-type": "application/json" });
    response.end(payload);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const runtimeRoot = join(root, ".t3", "userdata");
  await mkdir(runtimeRoot, { recursive: true });
  await writeFile(
    join(runtimeRoot, "server-runtime.json"),
    JSON.stringify({ version: 1, pid: process.pid, origin: `http://127.0.0.1:${address.port}` }),
  );
  await writeFile(join(runtimeRoot, "environment-id"), "fixture-environment");
  const spawn = childProcess.spawn;
  context.mock.method(childProcess, "spawn", (command: string, args: string[], options: { signal: AbortSignal }) => {
    assert.equal(command, "/usr/bin/ssh");
    assert.equal(args.includes("fixture-token"), false);
    // Execute the actual remote program against an isolated runtime and HTTP fixture.
    return spawn("/bin/sh", ["-c", args.at(-1)!], {
      ...options,
      env: { ...process.env, HOME: root },
      stdio: ["pipe", "pipe", "ignore"],
    });
  });
  syncBuiltinESMExports();
  const collect = () =>
    t3SshRequest(
      "fixture-host",
      { environmentId: "fixture-environment", token: "fixture-token" },
      new AbortController().signal,
    );
  try {
    const result = (await collect()) as { schemaVersion: number; threads: Array<Record<string, unknown>> };
    assert.equal(result.schemaVersion, 2);
    assert.deepEqual(
      result.threads.map((item) => item.id),
      ["working", "approval", "background", "done", "failed"],
    );
    assert.equal(result.threads[0]?.title, 'Задача 😀 ["{}"]');
    assert.equal(result.threads[1]?.pendingRuntimeRequest, true);
    assert.deepEqual(result.threads[2]?.pendingBackgroundTasks, [true]);
    assert.equal(JSON.stringify(result).includes("must-not-cross-ssh"), false);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) < 4096);
    for (const invalid of [
      '{"schemaVersion":2}',
      '{"schemaVersion":[2],"threads":[]}',
      '{"schemaVersion":2,"threads":[],"threads":[]}',
      `{"schemaVersion":2,"threads":[${JSON.stringify(working)},]}`,
      `{"schemaVersion":2,"threads":[${JSON.stringify(working)}`,
      '{"schemaVersion":2,"threads":[]}false',
      `{"schemaVersion":2,"threads":[],"projects":[${"[".repeat(65)}0${"]".repeat(65)}]}`,
      JSON.stringify({ schemaVersion: 2, threads: [thread("huge", "idle", { lineage: "x".repeat(262_144) })] }),
      JSON.stringify({ schemaVersion: 2, threads: Array.from({ length: 10_001 }, () => working) }),
      JSON.stringify({
        schemaVersion: 2,
        threads: Array.from({ length: 9000 }, () => thread("large", "running", { title: "x".repeat(1200) })),
      }),
    ]) {
      payload = invalid;
      await assert.rejects(collect(), /T3 SSH unavailable/u);
    }
    payload = JSON.stringify({ schemaVersion: 2, threads: active });
    status = 401;
    await assert.rejects(collect(), /T3 SSH unavailable/u);
  } finally {
    context.mock.restoreAll();
    syncBuiltinESMExports();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("remote Python deadline stops a continuously readable shell and closes the response", {
  skip: process.platform === "win32",
}, async () => {
  const program = `import json, sys, signal, time, urllib.request
exec(json.load(sys.stdin)["reader"])
origin = "http://127.0.0.1:12345"
closed = False
class Response:
 def __enter__(self): return self
 def __exit__(self, *args):
  global closed
  closed = True
 def read1(self, size):
  time.sleep(0.05)
  return b" " * 4096
class Opener:
 def open(self, *args, **kwargs): return Response()
opener = Opener()
def test_deadline(*args): raise RuntimeError("reader exceeded its own deadline")
signal.signal(signal.SIGALRM, test_deadline)
signal.setitimer(signal.ITIMER_REAL, 6)
try: read_shell("fixture-token", 0)
except TimeoutError: print(json.dumps({"deadline": True, "closed": closed}))
`;
  const result = await new Promise<string>((resolve, reject) => {
    const child = childProcess.spawn("python3", ["-c", program], {
      stdio: ["pipe", "pipe", "pipe"],
      signal: AbortSignal.timeout(8000),
    });
    let output = "";
    let error = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      error += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(output) : reject(new Error(error))));
    child.stdin.end(JSON.stringify({ reader: REMOTE_SHELL_READER }));
  });
  assert.deepEqual(JSON.parse(result), { deadline: true, closed: true });
});
