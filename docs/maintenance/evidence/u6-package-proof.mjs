// Run from the repository root after `npm run build`.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { build } from "esbuild";
import { WebSocketServer } from "ws";

const directory = await mkdtemp(join(tmpdir(), "codex-u6-package-"));
let port = 0;
const server = createServer((_request, response) => {
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify([{ type: "page", url: "app://-/index.html", webSocketDebuggerUrl: `ws://127.0.0.1:${port}/main` }]));
});
const sockets = new WebSocketServer({ server });
sockets.on("connection", socket => socket.on("message", raw => {
  const { id } = JSON.parse(String(raw));
  socket.send(JSON.stringify({ id, result: { result: { value: { ready: true } } } }));
}));
try {
  await cp("release/codex-deck-launcher/runtime-override.mjs", join(directory, "runtime-override.mjs"));
  await cp("release/codex-deck-launcher/node_modules", join(directory, "node_modules"), { recursive: true });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  port = server.address().port;
  const result = await promisify(execFile)(process.execPath, [join(directory, "runtime-override.mjs"), String(port)], { cwd: directory, timeout: 2_000 });
  assert.deepEqual(JSON.parse(result.stdout), { ready: true });
  const bundle = await build({ entryPoints: ["launcher/runtime-override.ts"], bundle: true, external: ["ws"], platform: "node", format: "esm", target: "node24", write: false, metafile: true });
  assert.ok(!Object.keys(bundle.metafile.inputs).some(name => name.includes("@elgato")));
  const code = await readFile(join(directory, "runtime-override.mjs"), "utf8");
  assert.ok(!code.includes("#codex"));
  console.log(JSON.stringify({ isolatedRuntime: "ready", sourceTsRequired: false, externalDependency: "ws", launcherImportsSDK: false, esbuildAliasResolution: true }));
} finally {
  for (const socket of sockets.clients) socket.terminate();
  await new Promise(resolve => sockets.close(resolve));
  await new Promise(resolve => server.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
