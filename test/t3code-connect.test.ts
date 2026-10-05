import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, stat, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const connector = new URL("../scripts/connect-t3.mjs", import.meta.url);

test("T3 connector requests only read access, saves a protected token, and never prints credentials", {
  skip: process.platform !== "darwin",
}, async () => {
  const home = await mkdtemp(join(tmpdir(), "deck-t3-connect-"));
  const server = createServer(async (request, response) => {
    if (request.url === "/oauth/token") {
      let body = "";
      for await (const chunk of request) body += chunk;
      const params = new URLSearchParams(body);
      assert.equal(params.get("scope"), "orchestration:read");
      assert.equal(params.get("subject_token"), "pairing-fixture");
      assert.equal(params.get("client_label"), "CodexDeck");
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({ token_type: "Bearer", scope: "orchestration:read", access_token: "access-fixture" }),
      );
    } else {
      assert.equal(request.url, "/api/orchestration/shell");
      assert.equal(request.headers.authorization, "Bearer access-fixture");
      assert.equal(request.headers["x-t3-orchestration-protocol"], "2");
      response.end(JSON.stringify({ schemaVersion: 2, threads: [] }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const run = (input: string) =>
    new Promise<{ code: number | null; output: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [connector.pathname], {
        env: { ...process.env, HOME: home },
        stdio: "pipe",
      });
      let output = "";
      child.stdout.on("data", (chunk) => {
        output += chunk;
      });
      child.stderr.on("data", (chunk) => {
        output += chunk;
      });
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, output }));
      child.stdin.end(input);
    });
  try {
    await mkdir(join(home, ".t3", "userdata"), { recursive: true });
    await writeFile(
      join(home, ".t3", "userdata", "server-runtime.json"),
      JSON.stringify({ version: 1, origin, pid: process.pid }),
    );
    const result = await run(JSON.stringify({ credential: "pairing-fixture" }));
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /T3 Code connected/u);
    assert.doesNotMatch(result.output, /pairing-fixture|access-fixture/u);
    const configPath = join(home, "Library", "Application Support", "CodexDeck", "t3code.json");
    const contents = await readFile(configPath, "utf8");
    assert.deepEqual(JSON.parse(contents), { origin, token: "access-fixture" });
    assert.equal((await stat(configPath)).mode & 0o777, 0o600);
    const invalid = await run('{"credential":"private-malformed-fixture"');
    assert.equal(invalid.code, 1);
    assert.doesNotMatch(invalid.output, /private-malformed-fixture/u);
    assert.equal(await readFile(configPath, "utf8"), contents);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(home, { recursive: true, force: true });
  }
});
