import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("context rings are optional in Stream Deck", async () => {
  const [manifest, inspector, plugin, render] = await Promise.all([
    readFile(new URL("../static/manifest.json", import.meta.url), "utf8"),
    readFile(new URL("../static/property-inspector/agent.html", import.meta.url), "utf8"),
    readFile(new URL("../src/plugin.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/render.ts", import.meta.url), "utf8")
  ]);
  assert.equal((manifest.match(/static\/property-inspector\/agent\.html/g) ?? []).length, 6);
  assert.match(inspector, /getGlobalSettings/);
  assert.match(inspector, /setGlobalSettings/);
  assert.match(inspector, /showContextRings/);
  assert.match(plugin, /onDidReceiveGlobalSettings/);
  assert.match(render, /data-context-used/);
});

test("Agent property inspector exposes an informed global active queue opt-in", async () => {
  const inspector = await readFile(new URL("../static/property-inspector/agent.html", import.meta.url), "utf8");
  assert.match(inspector, /id="show-context-rings"[^>]*type="checkbox"[^>]*disabled/);
  assert.match(inspector, /id="active-queue"[^>]*type="checkbox"[^>]*disabled/);
  assert.match(inspector, />Active queue</);
  assert.match(inspector, /full native pinned \+ unpinned sidebar catalog/i);
  assert.match(inspector, /fallback to the six Micro slots/i);
  assert.match(inspector, /Agent 1[\s\S]*Agent N/);
  assert.match(inspector, /contiguously/i);
  assert.match(inspector, /idle chats[^<]*unavailable/i);
  assert.match(inspector, /custom[\s\S]*six configured candidates[\s\S]*compact/i);
  assert.match(inspector, /globalSettings\s*=\s*\{\s*\.\.\.globalSettings,\s*activeQueueEnabled:/);
  assert.match(inspector, /globalSettings\s*=\s*\{\s*\.\.\.globalSettings,\s*showContextRings:/);
  const settingsReceived = inspector.slice(
    inspector.indexOf('if (event.event !== "didReceiveGlobalSettings") return;'),
    inspector.indexOf('document.getElementById("show-context-rings").addEventListener'));
  assert.match(settingsReceived, /globalSettings\s*=\s*event\.payload\?\.settings\s*\?\?\s*\{\}/);
  assert.match(inspector, /getElementById\("show-context-rings"\)\.disabled\s*=\s*false/);
  assert.match(inspector, /getElementById\("active-queue"\)\.disabled\s*=\s*forcedQueue/);
});

