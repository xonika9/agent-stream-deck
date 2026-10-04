import assert from "node:assert/strict";
import { build } from "esbuild";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WebSocketServer } from "ws";
import { verifyMicroRuntime } from "../launcher/runtime-override.js";
import type { DeckController } from "../src/controller.js";
import type { Fast } from "../src/actions.js";

test("bundled ESM actions retain SDK decoration and native press/release behavior", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-deck-actions-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const outfile = join(directory, "actions.mjs");
  await build({
    entryPoints: [fileURLToPath(new URL("../src/actions.ts", import.meta.url))],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" }
  });
  // A bundled SDK instance owns its own cwd-based logger. Keep its rotation
  // separate from SDK instances loaded by other test processes.
  const previousDirectory = process.cwd();
  let actions: { Fast: typeof Fast };
  try {
    process.chdir(directory);
    actions = await import(pathToFileURL(outfile).href) as { Fast: typeof Fast };
  } finally { process.chdir(previousDirectory); }
  const inputs: Array<[string, number]> = [];
  const controller = {
    sendMicroAction: async (slot: string, act: number) => { inputs.push([slot, act]); }
  } as unknown as DeckController;
  const action = new actions.Fast(controller);
  assert.equal(action.manifestId, "com.xonika9.codex-deck.fast");
  const event = { action: { showAlert: async () => assert.fail("native action unexpectedly failed") } };
  await action.onKeyDown(event as never);
  await action.onKeyUp(event as never);
  assert.deepEqual(inputs, [["ACT06", 1], ["ACT06", 0]]);
});

test("ESM launcher verifies the runtime over loopback HTTP and WebSocket CDP", async (context) => {
  let port = 0;
  const server = createServer((request, response) => {
    assert.equal(request.url, "/json/list");
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify([
      { type: "page", url: "app://-/index.html", webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/main` }
    ]));
  });
  const sockets = new WebSocketServer({ server });
  context.after(async () => {
    for (const socket of sockets.clients) socket.terminate();
    await new Promise<void>((resolve, reject) => sockets.close((error) => error ? reject(error) : resolve()));
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  port = address.port;
  const receipt = { ready: true, nativeEventBus: true, hidHandlers: 1, joystickHandlers: 1 };
  let evaluations = 0;
  let closed: Promise<unknown> | undefined;
  sockets.on("connection", (socket, request) => {
    assert.equal(request.url, "/devtools/page/main");
    closed = once(socket, "close");
    socket.on("message", (raw) => {
      const message = JSON.parse(String(raw)) as { id: number; method: string; params: { expression: string; awaitPromise: boolean; returnByValue: boolean } };
      assert.equal(message.method, "Runtime.evaluate");
      assert.equal(message.params.awaitPromise, true);
      assert.equal(message.params.returnByValue, true);
      assert.ok(message.params.expression.length > 0);
      evaluations += 1;
      // Notifications and unrelated responses must not complete the pending request.
      socket.send(JSON.stringify({ method: "Runtime.consoleAPICalled", params: {} }));
      socket.send(JSON.stringify({ id: message.id + 100, result: { result: { value: { ready: false } } } }));
      socket.send(JSON.stringify({ id: message.id, result: { result: { value: receipt } } }));
    });
  });
  assert.deepEqual(await verifyMicroRuntime(port, 2_000), receipt);
  assert.equal(evaluations, 1);
  assert.ok(closed);
  await closed;
});
