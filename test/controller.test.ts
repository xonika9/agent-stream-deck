import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { codexDeckStateRoot } from "../src/codex-deck-paths.js";
import test from "node:test";
import streamDeck from "@elgato/streamdeck";
import { DeckController } from "../src/controller.js";
import { Agent1 } from "../src/actions.js";
import type { HostSnapshot } from "../src/codex-local-state.js";
import type { CodexHost, MicroSnapshot, RoutedAgentSlot } from "../src/types.js";

const host: CodexHost = { hostId: "56fd97ad-7073-42cc-85ce-befa17546d7c", hostName: "Test Mac", platform: "darwin" };
const snapshot: MicroSnapshot = {
  slots: Array.from({ length: 6 }, (_, id) => ({
    id, threadKey: `00000000-0000-4000-8000-00000000000${id}`, title: `Task ${id + 1}`,
    status: id === 0 ? "working" : "idle", selected: id === 0, activityAt: 1_000 - id
  })),
  layout: {
    version: 1,
    slots: {
      ACT06: { keycapId: "FAST" }, ACT07: { keycapId: "APPR" }, ACT08: { keycapId: "REJ" },
      ACT09: { keycapId: "SPLIT" }, ACT10_ACT11: { keycapId: "CODEX" }, ACT12: { keycapId: "CODEX" }
    },
    analogStick: { up: {}, right: {}, down: {}, left: {} }
  },
  agentSource: "recent",
  lightingAutoOff: "3-minutes",
  theme: "dark"
};

test("active queue empty press stays a no-op across queue disable and a filled release", async () => {
  const controller = new DeckController();
  const sends: unknown[] = [];
  let alerts = 0;
  const internal = controller as unknown as {
    activeQueueEnabled: boolean;
    routedSlots: RoutedAgentSlot[];
    pressedAgents: Map<string, unknown>;
    emptyAgentPresses: Set<string>;
    localHost?: CodexHost;
    microBridge: { sendAgent: (...args: unknown[]) => Promise<void> };
  };
  internal.localHost = host;
  internal.routedSlots = [];
  internal.microBridge.sendAgent = async (...args) => { sends.push(args); };

  internal.activeQueueEnabled = false;
  await assert.rejects(controller.sendAgent(0, 1, { id: "first-key" }), /No Codex task is assigned/);
  internal.activeQueueEnabled = true;

  const action = new Agent1(controller);
  const event = { action: { id: "first-key", showAlert: async () => { alerts += 1; } } };
  await action.onKeyDown(event as never);
  assert.equal(internal.pressedAgents.size, 0);
  assert.equal(internal.emptyAgentPresses.has("first-key"), true);
  internal.activeQueueEnabled = false;
  internal.routedSlots = [{ ...snapshot.slots[0]!, host, sourceSlot: 0, observedAt: Date.now() }];
  await action.onKeyUp(event as never);

  assert.deepEqual(sends, []);
  assert.equal(alerts, 0);
  assert.equal(internal.pressedAgents.size, 0);
  assert.equal(internal.emptyAgentPresses.size, 0);
});

test("active queue black empty press clears an orphaned captured assignment", async () => {
  const controller = new DeckController();
  const sends: unknown[] = [];
  const orphaned = { ...snapshot.slots[0]!, host, sourceSlot: 0, observedAt: Date.now() };
  const internal = controller as unknown as {
    activeQueueEnabled: boolean;
    routedSlots: RoutedAgentSlot[];
    pressedAgents: Map<string, RoutedAgentSlot>;
    emptyAgentPresses: Set<string>;
    localHost?: CodexHost;
    microBridge: { sendAgent: (...args: unknown[]) => Promise<void> };
  };
  internal.activeQueueEnabled = true;
  internal.localHost = host;
  internal.routedSlots = [];
  internal.pressedAgents.set("first-key", orphaned);
  internal.microBridge.sendAgent = async (...args) => { sends.push(args); };

  await controller.sendAgent(0, 1, { id: "first-key" });
  assert.equal(internal.pressedAgents.size, 0);
  assert.equal(internal.emptyAgentPresses.has("first-key"), true);
  await controller.sendAgent(0, 0, { id: "first-key" });

  assert.deepEqual(sends, []);
  assert.equal(internal.pressedAgents.size, 0);
  assert.equal(internal.emptyAgentPresses.size, 0);
});

test("controller applies the active queue only after host routing and preserves native order by default", async () => {
  const input = structuredClone(snapshot);
  input.slots.forEach((slot) => { slot.status = "idle"; slot.selected = false; });
  input.slots[1]!.status = "working";
  input.slots[4]!.status = "working";
  input.slots[1]!.activityAt = 100;
  input.slots[4]!.activityAt = 200;
  const controller = new DeckController();
  const internal = controller as unknown as {
    activeQueueEnabled: boolean;
    localHost?: CodexHost;
    localSnapshot?: HostSnapshot;
    localHealth: { state: "ready" };
    routedSlots: Array<{ sourceSlot: number }>;
    refreshDisplay: () => Promise<void>;
  };
  internal.localHost = host;
  internal.localSnapshot = { host, snapshot: input, observedAt: Date.now() };
  internal.localHealth = { state: "ready" };

  internal.activeQueueEnabled = false;
  await internal.refreshDisplay();
  assert.deepEqual(internal.routedSlots.map((slot) => slot.sourceSlot), [0, 1, 2, 3, 4, 5]);

  internal.activeQueueEnabled = true;
  await internal.refreshDisplay();
  assert.deepEqual(internal.routedSlots.map((slot) => slot.sourceSlot), [1, 4]);
});

test("Both queue drops stopped local Codex tasks before assigning the first key to OpenCode", async () => {
  const controller = new DeckController({ foregroundOpenCode: async () => {} });
  const images: string[] = [];
  let alerts = 0;
  const internal = controller as unknown as {
    taskSource: "Both";
    localHost?: CodexHost;
    localSnapshot?: HostSnapshot;
    localHealth: { state: "degraded"; reason: "codex-not-running"; changedAt: number };
    openCodeHealth: { state: "ready"; changedAt: number };
    openCodeSlots: RoutedAgentSlot[];
    routedSlots: RoutedAgentSlot[];
    refreshDisplay: () => Promise<void>;
    microBridge: { sendAgent: () => Promise<void> };
  };
  internal.taskSource = "Both";
  internal.localHost = host;
  const staleSnapshot = structuredClone(snapshot);
  staleSnapshot.slots[0]!.status = "complete";
  staleSnapshot.slots[0]!.activityAt = 100;
  internal.localSnapshot = { host, snapshot: staleSnapshot, observedAt: Date.now() };
  internal.localHealth = { state: "degraded", reason: "codex-not-running", changedAt: Date.now() };
  internal.openCodeHealth = { state: "ready", changedAt: Date.now() };
  internal.openCodeSlots = [{
    id: 0, sourceSlot: 0, taskSource: "opencode", host,
    threadKey: "connection\0session", title: "OpenCode task", status: "complete",
    selected: false, activityAt: 200, observedAt: Date.now()
  }];
  internal.microBridge.sendAgent = async () => { throw new Error("Stopped Codex must not receive a press"); };
  await internal.refreshDisplay();

  const action = new Agent1(controller);
  const event = { action: {
    id: "first-key", isKey: () => true,
    setImage: async (image: string) => { images.push(decodeURIComponent(image)); },
    setTitle: async () => {}, showAlert: async () => { alerts++; }
  } };
  action.onWillAppear(event as never);
  await new Promise((resolve) => setImmediate(resolve));
  await action.onKeyDown(event as never);
  await action.onKeyUp(event as never);

  assert.equal(internal.routedSlots[0]?.taskSource, "opencode");
  assert.match(images.at(-1)!, /data-agent-host="O"/);
  assert.equal(alerts, 0);
});

test("controller keeps one working-rank epoch, advances on a higher revision, and resets it on disable", async () => {
  const input = structuredClone(snapshot);
  input.slots.forEach((slot) => { slot.status = "idle"; slot.selected = false; });
  Object.assign(input.slots[0]!, { status: "working", activityAt: 300, ownedByHost: true, workStartedAt: 300, workStartRevision: 1 });
  Object.assign(input.slots[1]!, { status: "working", activityAt: 200, ownedByHost: true, workStartedAt: 200, workStartRevision: 1 });
  Object.assign(input.slots[2]!, { status: "working", activityAt: 100, ownedByHost: true, workStartedAt: 100, workStartRevision: 1 });
  const controller = new DeckController();
  const internal = controller as unknown as {
    activeQueueEnabled: boolean;
    localHost?: CodexHost;
    localSnapshot?: HostSnapshot;
    localHealth: { state: "ready" };
    routedSlots: RoutedAgentSlot[];
    refreshDisplay: () => Promise<void>;
  };
  internal.localHost = host;
  internal.localSnapshot = { host, snapshot: input, observedAt: 1_000 };
  internal.localHealth = { state: "ready" };
  internal.activeQueueEnabled = true;

  await internal.refreshDisplay();
  assert.deepEqual(internal.routedSlots.map((slot) => slot.sourceSlot), [0, 1, 2]);
  Object.assign(input.slots[2]!, { selected: true, title: "Opened", activityAt: 9_000 });
  await internal.refreshDisplay();
  assert.deepEqual(internal.routedSlots.map((slot) => slot.sourceSlot), [0, 1, 2]);
  Object.assign(input.slots[2]!, { workStartedAt: 400, workStartRevision: 2 });
  await internal.refreshDisplay();
  assert.deepEqual(internal.routedSlots.map((slot) => slot.sourceSlot), [2, 0, 1]);

  delete input.slots[0]!.workStartedAt;
  delete input.slots[0]!.workStartRevision;
  delete input.slots[1]!.workStartedAt;
  delete input.slots[1]!.workStartRevision;
  delete input.slots[2]!.workStartedAt;
  delete input.slots[2]!.workStartRevision;
  controller.setAgentDisplaySettings({ activeQueueEnabled: false });
  await new Promise((resolve) => setImmediate(resolve));
  controller.setAgentDisplaySettings({ activeQueueEnabled: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(internal.routedSlots.map((slot) => slot.sourceSlot), [0, 1, 2]);
});

test("active queue settings default off and a change immediately reprojects registered agents", async () => {
  const input = structuredClone(snapshot);
  input.slots.forEach((slot) => { slot.status = "idle"; slot.selected = false; });
  input.slots[2]!.status = "working";
  const controller = new DeckController();
  const images: string[] = [];
  const action = {
    id: "agent-1", setImage: async (image: string) => { images.push(image); }, setTitle: async () => {}
  };
  const internal = controller as unknown as {
    activeQueueEnabled: boolean;
    showContextRings: boolean;
    localHost?: CodexHost;
    localSnapshot?: HostSnapshot;
    localHealth: { state: "ready" };
    routedSlots: Array<{ sourceSlot: number }>;
    refreshDisplay: () => Promise<void>;
  };
  internal.localHost = host;
  internal.localSnapshot = { host, snapshot: input, observedAt: Date.now() };
  internal.localHealth = { state: "ready" };
  await internal.refreshDisplay();
  controller.registerAgent(0, action as never);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(internal.activeQueueEnabled, false);
  const futureSettings = { showContextRings: false, futureSetting: "preserved" };
  controller.setAgentDisplaySettings(futureSettings);
  assert.equal(internal.activeQueueEnabled, false);
  assert.equal(internal.showContextRings, false);
  controller.setAgentDisplaySettings({ ...futureSettings, activeQueueEnabled: true });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(internal.routedSlots.map((slot) => slot.sourceSlot), [2]);
  assert.ok(images.length >= 2, "global option change rerenders registered Agent actions");
});

test("OpenCode task titles render locally and fall back to their content-free alias", async () => {
  const controller = new DeckController();
  const images: string[] = [];
  const internal = controller as unknown as {
    localHost?: CodexHost;
    openCodeHealth: { state: "ready" };
    routedSlots: RoutedAgentSlot[];
    openCodeSlot: (task: {
      source: "opencode";
      connectionId: string;
      sessionId: string;
      label: string;
      displayTitle?: string;
      status: "working";
    }, sourceSlot: number, observedAt: number) => RoutedAgentSlot;
    renderAgent: (registration: { action: unknown; slot: number }) => Promise<void>;
  };
  internal.localHost = host;
  internal.openCodeHealth = { state: "ready" };
  const task: Parameters<typeof internal.openCodeSlot>[0] = {
    source: "opencode" as const,
    connectionId: "opaque-connection",
    sessionId: "opaque-session",
    label: "OpenCode 7",
    displayTitle: "Live chat",
    status: "working" as const
  };
  internal.routedSlots = [internal.openCodeSlot(task, 0, Date.now())];
  const action = {
    id: "opencode-title", setImage: async (image: string) => { images.push(image); }, setTitle: async () => {}
  };

  await internal.renderAgent({ action, slot: 0 });
  const titled = decodeURIComponent(images.at(-1)!);
  assert.match(titled, /Live chat/);
  assert.match(titled, /data-agent-host="O"/);
  assert.match(titled, /data-theme="light"/);

  delete task.displayTitle;
  internal.routedSlots = [internal.openCodeSlot(task, 0, Date.now())];
  action.id = "opencode-alias";
  await internal.renderAgent({ action, slot: 0 });
  assert.match(decodeURIComponent(images.at(-1)!), /OpenCode 7/);
});

test("macOS usage source leaves theme unset when Codex has no renderer snapshot", () => {
  const controller = new DeckController();
  const internal = controller as unknown as {
    localHost?: CodexHost;
    localHealth: { state: "degraded"; reason: "codex-not-running"; changedAt: number };
    codexBarUsage?: {
      windows: [];
      observedAt: number;
      resetCreditsAvailable: null;
      resetCreditsApplicable: null;
    };
    accountUsageSource: () => { theme?: "light" | "dark" };
  };
  internal.localHost = host;
  internal.localHealth = { state: "degraded", reason: "codex-not-running", changedAt: 1 };
  internal.codexBarUsage = {
    windows: [], observedAt: 2, resetCreditsAvailable: null, resetCreditsApplicable: null
  };

  assert.equal(internal.accountUsageSource().theme, undefined);
});

test("pressing a terminal OpenCode task acknowledges that result after foregrounding", async () => {
  const order: string[] = [];
  const foregrounded: string[] = [];
  const acknowledged: string[] = [];
  const published: string[] = [];
  const controller = new DeckController({
    foregroundOpenCode: async () => { order.push("foreground"); foregrounded.push("foregrounded"); }
  });
  const internal = controller as unknown as {
    activeQueueEnabled: boolean;
    localHost?: CodexHost;
    openCodeHealth: { state: "ready" };
    openCodeCollector?: {
      acknowledgeTask: (connectionId: string, sessionId: string, terminalAt: number) => boolean;
      publishTaskViewed: (connectionId: string, sessionId: string) => Promise<boolean>;
      snapshot: () => { version: 1; observedAt: number; connections: [] };
    };
    routedSlots: RoutedAgentSlot[];
  };
  internal.activeQueueEnabled = true;
  internal.localHost = host;
  internal.openCodeHealth = { state: "ready" };
  internal.openCodeCollector = {
    acknowledgeTask(connectionId, sessionId, terminalAt) {
      order.push("acknowledge");
      acknowledged.push(`${connectionId}:${sessionId}:${terminalAt}`);
      return true;
    },
    async publishTaskViewed(connectionId, sessionId) {
      order.push("publish");
      published.push(`${connectionId}:${sessionId}`);
      throw new Error("API unavailable");
    },
    snapshot: () => ({ version: 1, observedAt: Date.now(), connections: [] })
  };
  const terminalAt = Date.now();
  internal.routedSlots = [{
    id: 0,
    sourceSlot: 0,
    catalogIndex: 0,
    taskSource: "opencode",
    host,
    threadKey: "opaque-connection\0opaque-session",
    conversationId: "opaque-connection\0opaque-session",
    title: "Finished task",
    status: "complete",
    selected: false,
    activityAt: terminalAt,
    observedAt: Date.now()
  }];

  const action = new Agent1(controller);
  const event = { action: { id: "first-key", showAlert: async () => assert.fail("API failure must remain best-effort") } };
  await action.onKeyDown(event as never);
  await action.onKeyUp(event as never);

  assert.deepEqual(order, ["foreground", "acknowledge", "publish"]);
  assert.deepEqual(foregrounded, ["foregrounded"]);
  assert.deepEqual(acknowledged, [`opaque-connection:opaque-session:${terminalAt}`]);
  assert.deepEqual(published, ["opaque-connection:opaque-session"]);
  assert.deepEqual(internal.routedSlots, []);
});

test("controller startup settings load defaults active queue off and restores persisted true", async () => {
  const settingsApi = streamDeck.settings as unknown as {
    getGlobalSettings: () => Promise<{ activeQueueEnabled?: boolean }>;
  };
  const originalGetGlobalSettings = settingsApi.getGlobalSettings;
  try {
    for (const [persisted, expected] of [[{}, false], [{ activeQueueEnabled: true }, true]] as const) {
      settingsApi.getGlobalSettings = async () => persisted;
      const controller = new DeckController();
      const internal = controller as unknown as {
        activeQueueEnabled: boolean;
        loadAgentDisplaySettings: () => Promise<void>;
      };

      await internal.loadAgentDisplaySettings();

      assert.equal(internal.activeQueueEnabled, expected);
    }
  } finally {
    settingsApi.getGlobalSettings = originalGetGlobalSettings;
  }
});

test("healthy queue gaps render black, unavailable diagnostics remain distinct, and duplicate images are suppressed", async () => {
  const controller = new DeckController();
  const images: string[] = [];
  const action = {
    id: "empty-agent", setImage: async (image: string) => { images.push(image); }, setTitle: async () => {}
  };
  const internal = controller as unknown as {
    activeQueueEnabled: boolean;
    localHost?: CodexHost;
    localHealth: { state: "ready" | "degraded" | "offline" | "connecting"; reason?: string };
    routedSlots: unknown[];
    renderAgent: (registration: { action: unknown; slot: number }) => Promise<void>;
  };
  internal.activeQueueEnabled = true;
  internal.localHost = host;
  internal.routedSlots = [];
  internal.localHealth = { state: "ready" };

  await internal.renderAgent({ action, slot: 0 });
  await internal.renderAgent({ action, slot: 0 });
  assert.equal(images.length, 1);
  assert.match(decodeURIComponent(images[0]!), /fill="#000000"/);

  const diagnostics = [
    { state: "degraded", title: /Signals[\s\S]*uncertain/ },
    { state: "offline", title: /Host[\s\S]*offline/ },
    { state: "connecting", title: /Connecting/ }
  ] as const;
  for (const diagnosticCase of diagnostics) {
    internal.localHealth = { state: diagnosticCase.state, reason: "test" };
    await internal.renderAgent({ action, slot: 0 });
    const diagnostic = decodeURIComponent(images.at(-1)!);
    assert.match(diagnostic, diagnosticCase.title);
    assert.match(diagnostic, new RegExp(`data-agent-host-health="${diagnosticCase.state}"`));
    assert.doesNotMatch(diagnostic, /fill="#000000"\/>(?:<\/svg>)?$/);
  }
  assert.equal(images.length, 4);
});

test("only local codex-not-running blanks the first four Agent keys", async () => {
  const controller = new DeckController();
  const internal = controller as unknown as {
    activeQueueEnabled: boolean;
    localHost?: CodexHost;
    localHealth: { state: "ready" | "degraded" | "offline" | "connecting"; reason?: string };
    routedSlots: RoutedAgentSlot[];
    renderAgent: (registration: { action: unknown; slot: number }) => Promise<void>;
  };
  internal.activeQueueEnabled = false;
  internal.localHost = host;
  internal.routedSlots = [];
  internal.localHealth = { state: "degraded", reason: "codex-not-running" };

  const render = async (slot: number): Promise<string> => {
    const images: string[] = [];
    await internal.renderAgent({
      slot,
      action: { id: `agent-${slot}`, setImage: async (image: string) => { images.push(image); }, setTitle: async () => {} }
    });
    return decodeURIComponent(images.at(-1)!);
  };

  for (const slot of [0, 1, 2, 3]) {
    assert.match(await render(slot), /<rect width="144" height="144" fill="#000000"\/>/);
  }
  assert.match(await render(4), /Signals[\s\S]*uncertain/);

  internal.localHealth = { state: "ready" };
  assert.doesNotMatch(await render(0), /<rect width="144" height="144" fill="#000000"\/>/);

  internal.localHealth = { state: "degraded", reason: "local-bridge-unavailable" };
  assert.match(await render(0), /Signals[\s\S]*uncertain/);

});

for (const disappear of [false, true]) {
  test(`identical Agent instances isolate captured presses${disappear ? " after disappearance" : " across queue churn"}`, async () => {
    const controller = new DeckController();
    const internal = controller as unknown as {
      localHost: CodexHost;
      routedSlots: RoutedAgentSlot[];
      microBridge: { sendAgent: (...args: unknown[]) => Promise<void> };
      refresh: () => Promise<void>;
    };
    internal.localHost = host;
    const original = { ...snapshot.slots[0]!, host, sourceSlot: 0, observedAt: 1_000 };
    const replacement = { ...snapshot.slots[1]!, host, sourceSlot: 1, observedAt: 2_000 };
    const sends: unknown[][] = [];
    internal.microBridge.sendAgent = async (...args) => { sends.push(args); };
    internal.refresh = async () => {};
    internal.routedSlots = [original];
    const action = new Agent1(controller);
    const event = (id: string) => ({ action: {
      id, isKey: () => true, setImage: async () => {}, setTitle: async () => {},
      showAlert: async () => {}
    } });
    const first = event("deck-one"), second = event("deck-two");
    action.onWillAppear(first as never);
    action.onWillAppear(second as never);
    await action.onKeyDown(first as never);
    if (disappear) action.onWillDisappear(first as never);
    internal.routedSlots = [replacement];
    await action.onKeyDown(second as never);
    await action.onKeyUp(first as never);
    assert.equal(sends.length, disappear ? 2 : 3, "only the captured instance may release its own task");
    await action.onKeyUp(second as never);
    assert.deepEqual(sends, [
      [0, 1, original.threadKey], [1, 1, replacement.threadKey],
      ...(disappear ? [] : [[0, 0, original.threadKey]]), [1, 0, replacement.threadKey]
    ]);
  });
}

test("startup and legacy host action use the local bridge while preserving old private selection files", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-local-startup-"));
  const stateRoot = codexDeckStateRoot(process.platform, root, root);
  try {
    await mkdir(stateRoot, { recursive: true });
    const identity = { ...host, platform: process.platform === "darwin" ? "darwin" : "win32" };
    const privateFiles = {
      "host.json": JSON.stringify(identity),
      "relay-client.json": JSON.stringify({ enabled: true, url: "ws://127.0.0.1:9", token: "test-private-token" }),
      "relay-server.json": JSON.stringify({ enabled: true, listenHost: "127.0.0.1", port: 9, token: "test-private-token" })
    };
    for (const [name, contents] of Object.entries(privateFiles)) await writeFile(join(stateRoot, name), contents);
    const scriptPath = join(root, "startup.mjs");
    const controllerUrl = pathToFileURL(fileURLToPath(new URL("../src/controller.ts", import.meta.url))).href;
    const actionsUrl = pathToFileURL(fileURLToPath(new URL("../src/actions.ts", import.meta.url))).href;
    const sdkUrl = import.meta.resolve("@elgato/streamdeck");
    await writeFile(scriptPath, `
      import assert from "node:assert/strict";
      import streamDeck from ${JSON.stringify(sdkUrl)};
      import { DeckController } from ${JSON.stringify(controllerUrl)};
      import { Agent1, HostToggle } from ${JSON.stringify(actionsUrl)};
      streamDeck.settings.getGlobalSettings = async () => ({ activeQueueEnabled: false });
      const controller = new DeckController();
      controller.microBridge.refresh = async () => (${JSON.stringify(snapshot)});
      const sends = [];
      controller.microBridge.sendAgent = async (...args) => { sends.push(args); };
      const images = [];
      const event = { action: { id: "legacy-profile-key", isKey: () => true,
        setImage: async image => images.push(decodeURIComponent(image)), setTitle: async () => {},
        showAlert: async () => { throw new Error("legacy local action alerted"); }
      } };
      try {
        await controller.start();
        const legacy = new HostToggle(controller);
        legacy.onWillAppear(event);
        await legacy.onKeyDown(event);
        assert.match(images.at(-1), /data-host-target="${identity.platform === "darwin" ? "MAC" : "WIN"}"/);
        const agent = new Agent1(controller);
        await agent.onKeyDown(event);
        await agent.onKeyUp(event);
        assert.deepEqual(sends, [[0, 1, ${JSON.stringify(snapshot.slots[0]!.threadKey)}], [0, 0, ${JSON.stringify(snapshot.slots[0]!.threadKey)}]]);
      } finally { controller.stop(); }
    `);
    for (const selection of ["darwin", "win32", "unknown"]) {
      const target = JSON.stringify({ platform: selection });
      await writeFile(join(stateRoot, "control-target.json"), target);
      const result = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), scriptPath], {
        cwd: root,
        env: { ...process.env, HOME: root, LOCALAPPDATA: root }, encoding: "utf8", timeout: 15_000
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.equal(await readFile(join(stateRoot, "control-target.json"), "utf8"), target);
      for (const [name, contents] of Object.entries(privateFiles)) assert.equal(await readFile(join(stateRoot, name), "utf8"), contents);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a delayed OpenCode foreground receipt uses the saved revision and does not publish a rejected acknowledgement", async () => {
  let foregroundReady!: () => void;
  const foreground = new Promise<void>((resolve) => { foregroundReady = resolve; });
  const controller = new DeckController({ foregroundOpenCode: () => foreground });
  const internal = controller as unknown as {
    taskSource: "OpenCode";
    localHost: CodexHost;
    routedSlots: RoutedAgentSlot[];
    openCodeCollector: {
      acknowledgeTask: (connectionId: string, sessionId: string, terminalAt: number) => boolean;
      publishTaskViewed: () => Promise<boolean>;
    };
  };
  internal.taskSource = "OpenCode";
  internal.localHost = host;
  const original: RoutedAgentSlot = {
    ...snapshot.slots[0]!, taskSource: "opencode", host,
    threadKey: "connection\0session", sourceSlot: 0, status: "complete", activityAt: 100, observedAt: 1_000
  };
  const newer = { ...original, activityAt: 200, observedAt: 2_000 };
  internal.routedSlots = [original];
  const receipts: unknown[][] = [];
  internal.openCodeCollector = {
    acknowledgeTask: (...args) => { receipts.push(args); return false; },
    publishTaskViewed: async () => assert.fail("rejected stale revision must not be published")
  };
  const action = new Agent1(controller);
  const event = { action: { id: "late-key", showAlert: async () => assert.fail("stale revision is a safe no-op") } };
  const press = action.onKeyDown(event as never);
  assert.deepEqual(receipts, [], "acknowledgement must wait for foregrounding");
  internal.routedSlots = [newer];
  foregroundReady();
  await press;
  await action.onKeyUp(event as never);
  assert.deepEqual(receipts, [["connection", "session", 100]]);
  assert.deepEqual(internal.routedSlots, [newer], "a newer displayed result remains available");
});
