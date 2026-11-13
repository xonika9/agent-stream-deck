import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { parseTaskSources, taskSourceNames } from "#agents";

type FakeElement = {
  id: string;
  value: string;
  checked: boolean;
  disabled: boolean;
  textContent: string;
  listeners: Map<string, (event: { target: FakeElement }) => void>;
  addEventListener: (type: string, listener: (event: { target: FakeElement }) => void) => void;
};

const INSPECTOR_IDS = [
  "task-source-codex",
  "task-source-opencode",
  "task-source-t3",
  "task-source-help",
  "show-context-rings",
  "active-queue",
  "active-queue-help",
] as const;

async function loadInspector() {
  const html = await readFile(new URL("../static/property-inspector/agent.html", import.meta.url), "utf8");
  const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1];
  assert.ok(script, "agent inspector script");
  const elements = new Map<string, FakeElement>();
  for (const id of INSPECTOR_IDS) {
    const tag = html.match(new RegExp(`<[a-z]+ id="${id}"[^>]*>`))?.[0] ?? "";
    const element: FakeElement = {
      id,
      value: "",
      checked: /\schecked\b/.test(tag),
      disabled: /\sdisabled\b/.test(tag),
      textContent: "",
      listeners: new Map(),
      addEventListener: (type, listener) => element.listeners.set(type, listener),
    };
    elements.set(id, element);
  }
  const sockets: FakeWebSocket[] = [];
  class FakeWebSocket {
    static OPEN = 1;
    readyState = 0;
    sent: Array<Record<string, unknown>> = [];
    listeners = new Map<string, (event: { data?: string }) => void>();
    constructor(readonly url: string) {
      sockets.push(this);
    }
    addEventListener(type: string, listener: (event: { data?: string }) => void): void {
      this.listeners.set(type, listener);
    }
    send(data: string): void {
      this.sent.push(JSON.parse(data));
    }
    open(): void {
      this.readyState = FakeWebSocket.OPEN;
      this.listeners.get("open")?.({});
    }
    receive(event: Record<string, unknown>): void {
      this.listeners.get("message")?.({ data: JSON.stringify(event) });
    }
  }
  const window: {
    connectElgatoStreamDeckSocket?: (port: number, uuid: string, registerEvent: string, info?: unknown) => void;
  } = {};
  runInNewContext(script, {
    window,
    WebSocket: FakeWebSocket,
    document: { getElementById: (id: string) => elements.get(id) ?? null },
  });
  const element = (id: (typeof INSPECTOR_IDS)[number]): FakeElement => elements.get(id)!;
  const connect = (info?: unknown): FakeWebSocket => {
    window.connectElgatoStreamDeckSocket?.(28196, "inspector-context", "registerPropertyInspector", info);
    const socket = sockets.at(-1);
    assert.ok(socket, "inspector opened a socket");
    socket.open();
    return socket;
  };
  const receiveSettings = (socket: FakeWebSocket, settings: Record<string, unknown> | undefined) =>
    socket.receive({ event: "didReceiveGlobalSettings", payload: settings === undefined ? {} : { settings } });
  const change = (id: (typeof INSPECTOR_IDS)[number], update: Partial<FakeElement>) => {
    Object.assign(element(id), update);
    element(id).listeners.get("change")?.({ target: element(id) });
  };
  const checkedSources = (): string[] => {
    const names: Array<[string, string]> = [
      ["task-source-codex", "Codex"],
      ["task-source-opencode", "OpenCode"],
      ["task-source-t3", "T3 Code"],
    ];
    return names.filter(([id]) => element(id as (typeof INSPECTOR_IDS)[number]).checked).map(([, name]) => name);
  };
  return { html, element, connect, receiveSettings, change, checkedSources };
}

test("all six Agent actions open the shared agent property inspector", async () => {
  const manifest = JSON.parse(await readFile(new URL("../static/manifest.json", import.meta.url), "utf8")) as {
    Actions: Array<{ UUID: string; PropertyInspectorPath?: string }>;
  };
  const inspectors = new Map(manifest.Actions.map((action) => [action.UUID, action.PropertyInspectorPath]));
  for (let slot = 1; slot <= 6; slot += 1) {
    assert.equal(
      inspectors.get(`com.xonika9.codex-deck.agent-${slot}`),
      "static/property-inspector/agent.html",
      `agent-${slot}`,
    );
  }
});

test("the plugin applies inspector global settings to the controller", async () => {
  const plugin = await readFile(new URL("../src/plugin.ts", import.meta.url), "utf8");
  // Registered at module load against the Stream Deck SDK, so the cheapest guard is the subscription itself.
  assert.match(plugin, /onDidReceiveGlobalSettings[\s\S]{0,160}controller\.setAgentDisplaySettings\(event\.settings\)/);
});

test("Agent inspector checkboxes are the values the plugin parses", async () => {
  const { html } = await loadInspector();
  const names = [...html.matchAll(/<label><input id="task-source-[^"]+"[^>]*>\s*([^<]+)<\/label>/gu)].map((match) =>
    match[1]!.trim(),
  );
  assert.deepEqual(names, ["Codex", "OpenCode", "T3 Code"]);
  for (const name of names) assert.deepEqual(taskSourceNames(parseTaskSources({ taskSource: name })), [name]);
  assert.deepEqual(taskSourceNames(parseTaskSources({ taskSource: "All" })), ["Codex", "OpenCode", "T3 Code"]);
});

test("Agent inspector registers, requests global settings, and stays disabled until they arrive", async () => {
  const { element, connect } = await loadInspector();
  assert.equal(element("task-source-codex").disabled, true);
  assert.equal(element("task-source-opencode").disabled, true);
  assert.equal(element("task-source-t3").disabled, true);
  assert.equal(element("show-context-rings").disabled, true);
  assert.equal(element("active-queue").disabled, true);
  const socket = connect();
  assert.equal(socket.url, "ws://127.0.0.1:28196");
  assert.deepEqual(socket.sent, [
    { event: "registerPropertyInspector", uuid: "inspector-context" },
    { event: "getGlobalSettings", context: "inspector-context" },
  ]);
  socket.receive({ event: "didReceiveSettings", payload: { settings: { showContextRings: false } } });
  assert.equal(element("show-context-rings").disabled, true, "only global settings enable the controls");
});

test("Agent inspector defaults context rings on and the Codex active queue off", async () => {
  const { element, connect, receiveSettings, checkedSources } = await loadInspector();
  receiveSettings(connect(), undefined);
  assert.deepEqual(checkedSources(), ["Codex"]);
  assert.equal(element("task-source-codex").disabled, true, "the last checked box cannot be unchecked");
  assert.equal(element("task-source-opencode").disabled, false);
  assert.equal(element("show-context-rings").checked, true);
  assert.equal(element("show-context-rings").disabled, false);
  assert.equal(element("active-queue").checked, false);
  assert.equal(element("active-queue").disabled, false);
  assert.match(element("active-queue-help").textContent, /fallback to the six Micro slots/);
});

test("Agent inspector maps legacy values to checkbox sets and forces the queue", async () => {
  const { element, connect, receiveSettings, checkedSources } = await loadInspector();
  const socket = connect();
  receiveSettings(socket, { taskSource: "Both", activeQueueEnabled: false, showContextRings: false });
  assert.deepEqual(checkedSources(), ["Codex", "OpenCode", "T3 Code"], "legacy Both upgrades to all three");
  assert.equal(element("show-context-rings").checked, false);
  assert.equal(element("active-queue").checked, true);
  assert.equal(element("active-queue").disabled, true);
  assert.match(element("active-queue-help").textContent, /Return to Codex alone to restore your saved preference/);

  receiveSettings(socket, { taskSource: "OpenCode", activeQueueEnabled: false });
  assert.deepEqual(checkedSources(), ["OpenCode"]);
  assert.equal(element("task-source-opencode").disabled, true, "the last checked box cannot be unchecked");
  assert.equal(element("active-queue").checked, true);
  assert.equal(element("active-queue").disabled, true);

  receiveSettings(socket, { taskSources: ["Codex", "T3 Code"] });
  assert.deepEqual(checkedSources(), ["Codex", "T3 Code"], "OpenCode stays off");
  assert.equal(element("task-source-opencode").disabled, false);
  assert.equal(element("active-queue").checked, true, "any non-Codex source forces the queue");

  receiveSettings(socket, { taskSources: [] });
  assert.deepEqual(checkedSources(), ["Codex"], "an empty set falls back to Codex");
  receiveSettings(socket, { taskSources: ["bogus"] });
  assert.deepEqual(checkedSources(), ["Codex"], "garbage falls back to Codex");
  receiveSettings(socket, { taskSource: "unexpected" });
  assert.deepEqual(checkedSources(), ["Codex"], "unknown sources fall back to Codex");
});

test("Agent inspector cannot uncheck the last box and saves both settings fields", async () => {
  const { connect, receiveSettings, change, checkedSources } = await loadInspector();
  const socket = connect();
  receiveSettings(socket, { taskSource: "All", activeQueueEnabled: false, showContextRings: false });

  socket.sent = [];
  change("task-source-opencode", { checked: false });
  assert.deepEqual(checkedSources(), ["Codex", "T3 Code"]);
  assert.deepEqual(socket.sent, [
    {
      event: "setGlobalSettings",
      context: "inspector-context",
      payload: {
        taskSource: "All",
        activeQueueEnabled: false,
        showContextRings: false,
        taskSources: ["Codex", "T3 Code"],
      },
    },
  ]);

  socket.sent = [];
  change("task-source-t3", { checked: false });
  change("task-source-codex", { checked: false });
  assert.deepEqual(checkedSources(), ["Codex"]);
  assert.deepEqual(socket.sent, [
    {
      event: "setGlobalSettings",
      context: "inspector-context",
      payload: {
        taskSource: "Codex",
        activeQueueEnabled: false,
        showContextRings: false,
        taskSources: ["Codex"],
      },
    },
  ]);

  socket.sent = [];
  change("task-source-codex", { checked: false });
  assert.deepEqual(checkedSources(), ["Codex"], "the last checked box stays checked");
  assert.deepEqual(socket.sent, [], "unchecking the last box saves nothing");

  receiveSettings(socket, { taskSources: ["Codex"] });
  socket.sent = [];
  change("task-source-opencode", { checked: true });
  assert.deepEqual(socket.sent, [
    {
      event: "setGlobalSettings",
      context: "inspector-context",
      payload: { taskSources: ["Codex", "OpenCode"], taskSource: "All" },
    },
  ]);
});

test("Agent inspector saves a single OpenCode source with its legacy value", async () => {
  const { connect, receiveSettings, change } = await loadInspector();
  const socket = connect();
  receiveSettings(socket, { taskSource: "Codex" });
  change("task-source-opencode", { checked: true });
  socket.sent = [];
  change("task-source-codex", { checked: false });
  assert.deepEqual(socket.sent, [
    {
      event: "setGlobalSettings",
      context: "inspector-context",
      payload: { taskSource: "OpenCode", taskSources: ["OpenCode"] },
    },
  ]);
});

test("Agent inspector on Windows disables OpenCode and T3 Code", async () => {
  const { element, connect, receiveSettings, checkedSources } = await loadInspector();
  const socket = connect(JSON.stringify({ application: { platform: "windows" } }));
  receiveSettings(socket, { taskSource: "All" });
  assert.deepEqual(checkedSources(), ["Codex", "OpenCode", "T3 Code"]);
  assert.equal(element("task-source-codex").disabled, false);
  assert.equal(element("task-source-opencode").disabled, true);
  assert.equal(element("task-source-t3").disabled, true);
  assert.match(element("task-source-help").textContent, /Windows supports Codex tasks only/);
});

test("Agent inspector toggles save their global keys without dropping other settings", async () => {
  const { connect, receiveSettings, change } = await loadInspector();
  const socket = connect();
  receiveSettings(socket, { taskSources: ["OpenCode"], futureSetting: 7 });
  socket.sent = [];
  change("show-context-rings", { checked: false });
  change("active-queue", { checked: true });
  assert.deepEqual(
    socket.sent.map((message) => message.payload),
    [
      { taskSources: ["OpenCode"], futureSetting: 7, showContextRings: false },
      { taskSources: ["OpenCode"], futureSetting: 7, showContextRings: false, activeQueueEnabled: true },
    ],
  );
});
