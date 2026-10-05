import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { codexDeckStateRoot } from "../src/runtime/paths.js";
import test from "node:test";
import streamDeck from "@elgato/streamdeck";
import { DeckController } from "#stream-deck";
import { CodexSource } from "#codex";
import { CODEX_BAR_FRESH_MS, parseCodexBarUsage } from "#usage";
import { OpenCodeSource, openCodeTaskSlot } from "#opencode";
import { Agent1, ReasoningUp, RateLimitReset } from "#stream-deck";
import type { HostSnapshot } from "#agents";
import type { CodexHost, MicroSnapshot, RoutedAgentSlot } from "#agents";

function createController(options: { foregroundOpenCode?: () => Promise<void> } = {}): DeckController {
  return new DeckController({
    codex: new CodexSource(() => {}),
    openCode: new OpenCodeSource(() => {}, options.foregroundOpenCode),
  });
}

function sources(controller: DeckController): { codex: CodexSource; openCode: OpenCodeSource } {
  return (controller as unknown as { sources: { codex: CodexSource; openCode: OpenCodeSource } }).sources;
}

const host: CodexHost = { hostId: "56fd97ad-7073-42cc-85ce-befa17546d7c", hostName: "Test Mac", platform: "darwin" };
const snapshot: MicroSnapshot = {
  slots: Array.from({ length: 6 }, (_, id) => ({
    id,
    threadKey: `00000000-0000-4000-8000-00000000000${id}`,
    title: `Task ${id + 1}`,
    status: id === 0 ? "working" : "idle",
    selected: id === 0,
    activityAt: 1_000 - id,
  })),
  layout: {
    version: 1,
    slots: {
      ACT06: { keycapId: "FAST" },
      ACT07: { keycapId: "APPR" },
      ACT08: { keycapId: "REJ" },
      ACT09: { keycapId: "SPLIT" },
      ACT10_ACT11: { keycapId: "CODEX" },
      ACT12: { keycapId: "CODEX" },
    },
    analogStick: { up: {}, right: {}, down: {}, left: {} },
  },
  agentSource: "recent",
  lightingAutoOff: "3-minutes",
  theme: "dark",
};

test("active queue empty press stays a no-op across queue disable and a filled release", async () => {
  const controller = createController();
  const sends: unknown[] = [];
  let alerts = 0;
  const internal = controller as unknown as {
    activeQueueEnabled: boolean;
    routedSlots: RoutedAgentSlot[];
    localHost?: CodexHost;
    microBridge: { sendAgent: (...args: unknown[]) => Promise<void> };
  };
  sources(controller).codex.localHost = host;
  internal.routedSlots = [];
  sources(controller).codex.microBridge.sendAgent = async (...args) => {
    sends.push(args.slice(0, 3));
  };

  internal.activeQueueEnabled = false;
  await assert.rejects(controller.sendAgent(0, 1, { id: "first-key" }), /No Codex task is assigned/);
  internal.activeQueueEnabled = true;

  const action = new Agent1(controller);
  const event = {
    action: {
      id: "first-key",
      showAlert: async () => {
        alerts += 1;
      },
    },
  };
  await action.onKeyDown(event as never);
  internal.activeQueueEnabled = false;
  internal.routedSlots = [{ ...snapshot.slots[0]!, host, sourceSlot: 0, observedAt: Date.now() }];
  await action.onKeyUp(event as never);

  assert.deepEqual(sends, []);
  assert.equal(alerts, 0);
});

test("active queue black empty press stays a no-op for an empty slot", async () => {
  const controller = createController();
  const sends: unknown[] = [];
  const internal = controller as unknown as {
    activeQueueEnabled: boolean;
    routedSlots: RoutedAgentSlot[];
    localHost?: CodexHost;
    microBridge: { sendAgent: (...args: unknown[]) => Promise<void> };
  };
  internal.activeQueueEnabled = true;
  sources(controller).codex.localHost = host;
  internal.routedSlots = [];
  sources(controller).codex.microBridge.sendAgent = async (...args) => {
    sends.push(args.slice(0, 3));
  };

  await controller.sendAgent(0, 1, { id: "first-key" });
  await controller.sendAgent(0, 0, { id: "first-key" });

  assert.deepEqual(sends, []);
});

test("controller applies the active queue only after host routing and preserves native order by default", async () => {
  const input = structuredClone(snapshot);
  input.slots.forEach((slot) => {
    slot.status = "idle";
    slot.selected = false;
  });
  input.slots[1]!.status = "working";
  input.slots[4]!.status = "working";
  input.slots[1]!.activityAt = 100;
  input.slots[4]!.activityAt = 200;
  const controller = createController();
  const internal = controller as unknown as {
    activeQueueEnabled: boolean;
    localHost?: CodexHost;
    localSnapshot?: HostSnapshot;
    localHealth: { state: "ready" };
    routedSlots: Array<{ sourceSlot: number }>;
    refreshDisplay: () => Promise<void>;
  };
  sources(controller).codex.localHost = host;
  sources(controller).codex.localSnapshot = { host, snapshot: input, observedAt: Date.now() };
  sources(controller).codex.localHealth = { state: "ready", changedAt: 1 };

  internal.activeQueueEnabled = false;
  await internal.refreshDisplay();
  assert.deepEqual(
    internal.routedSlots.map((slot) => slot.sourceSlot),
    [0, 1, 2, 3, 4, 5],
  );

  internal.activeQueueEnabled = true;
  await internal.refreshDisplay();
  assert.deepEqual(
    internal.routedSlots.map((slot) => slot.sourceSlot),
    [1, 4],
  );
});

test("Both queue drops stopped local Codex tasks before assigning the first key to OpenCode", async () => {
  const controller = createController({ foregroundOpenCode: async () => {} });
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
  sources(controller).codex.localHost = host;
  const staleSnapshot = structuredClone(snapshot);
  staleSnapshot.slots[0]!.status = "complete";
  staleSnapshot.slots[0]!.activityAt = 100;
  sources(controller).codex.localSnapshot = { host, snapshot: staleSnapshot, observedAt: Date.now() };
  sources(controller).codex.localHealth = { state: "degraded", reason: "codex-not-running", changedAt: Date.now() };
  (sources(controller).openCode as unknown as typeof internal).openCodeHealth = {
    state: "ready",
    changedAt: Date.now(),
  };
  (sources(controller).openCode as unknown as typeof internal).openCodeSlots = [
    {
      id: 0,
      sourceSlot: 0,
      taskSource: "opencode",
      host,
      threadKey: "connection\0session",
      title: "OpenCode task",
      status: "complete",
      selected: false,
      activityAt: 200,
      observedAt: Date.now(),
    },
  ];
  sources(controller).codex.microBridge.sendAgent = async () => {
    throw new Error("Stopped Codex must not receive a press");
  };
  await internal.refreshDisplay();

  const action = new Agent1(controller);
  const event = {
    action: {
      id: "first-key",
      isKey: () => true,
      setImage: async (image: string) => {
        images.push(decodeURIComponent(image));
      },
      setTitle: async () => {},
      showAlert: async () => {
        alerts++;
      },
    },
  };
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
  input.slots.forEach((slot) => {
    slot.status = "idle";
    slot.selected = false;
  });
  Object.assign(input.slots[0]!, {
    status: "working",
    activityAt: 300,
    ownedByHost: true,
    workStartedAt: 300,
    workStartRevision: 1,
  });
  Object.assign(input.slots[1]!, {
    status: "working",
    activityAt: 200,
    ownedByHost: true,
    workStartedAt: 200,
    workStartRevision: 1,
  });
  Object.assign(input.slots[2]!, {
    status: "working",
    activityAt: 100,
    ownedByHost: true,
    workStartedAt: 100,
    workStartRevision: 1,
  });
  const controller = createController();
  const internal = controller as unknown as {
    activeQueueEnabled: boolean;
    localHost?: CodexHost;
    localSnapshot?: HostSnapshot;
    localHealth: { state: "ready" };
    routedSlots: RoutedAgentSlot[];
    refreshDisplay: () => Promise<void>;
  };
  sources(controller).codex.localHost = host;
  sources(controller).codex.localSnapshot = { host, snapshot: input, observedAt: 1_000 };
  sources(controller).codex.localHealth = { state: "ready", changedAt: 1 };
  internal.activeQueueEnabled = true;

  await internal.refreshDisplay();
  assert.deepEqual(
    internal.routedSlots.map((slot) => slot.sourceSlot),
    [0, 1, 2],
  );
  Object.assign(input.slots[2]!, { selected: true, title: "Opened", activityAt: 9_000 });
  await internal.refreshDisplay();
  assert.deepEqual(
    internal.routedSlots.map((slot) => slot.sourceSlot),
    [0, 1, 2],
  );
  Object.assign(input.slots[2]!, { workStartedAt: 400, workStartRevision: 2 });
  await internal.refreshDisplay();
  assert.deepEqual(
    internal.routedSlots.map((slot) => slot.sourceSlot),
    [2, 0, 1],
  );

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
  assert.deepEqual(
    internal.routedSlots.map((slot) => slot.sourceSlot),
    [0, 1, 2],
  );
});

test("active queue settings default off and a change immediately reprojects registered agents", async () => {
  const input = structuredClone(snapshot);
  input.slots.forEach((slot) => {
    slot.status = "idle";
    slot.selected = false;
  });
  input.slots[2]!.status = "working";
  const controller = createController();
  const images: string[] = [];
  const action = {
    id: "agent-1",
    setImage: async (image: string) => {
      images.push(image);
    },
    setTitle: async () => {},
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
  sources(controller).codex.localHost = host;
  sources(controller).codex.localSnapshot = { host, snapshot: input, observedAt: Date.now() };
  sources(controller).codex.localHealth = { state: "ready", changedAt: 1 };
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

  assert.deepEqual(
    internal.routedSlots.map((slot) => slot.sourceSlot),
    [2],
  );
  assert.ok(images.length >= 2, "global option change rerenders registered Agent actions");
});

test("OpenCode task titles render locally and fall back to their content-free alias", async () => {
  const controller = createController();
  const images: string[] = [];
  const internal = controller as unknown as {
    localHost?: CodexHost;
    openCodeHealth: { state: "ready" };
    routedSlots: RoutedAgentSlot[];
    openCodeSlot: (
      task: {
        source: "opencode";
        connectionId: string;
        sessionId: string;
        label: string;
        displayTitle?: string;
        status: "working";
      },
      sourceSlot: number,
      observedAt: number,
    ) => RoutedAgentSlot;
    renderAgent: (registration: { action: unknown; slot: number }) => Promise<void>;
  };
  sources(controller).codex.localHost = host;
  (sources(controller).openCode as unknown as typeof internal).openCodeHealth = { state: "ready" };
  const task: Parameters<typeof internal.openCodeSlot>[0] = {
    source: "opencode" as const,
    connectionId: "opaque-connection",
    sessionId: "opaque-session",
    label: "OpenCode 7",
    displayTitle: "Live chat",
    status: "working" as const,
  };
  internal.routedSlots = [openCodeTaskSlot(task, 0, Date.now(), host)];
  const action = {
    id: "opencode-title",
    setImage: async (image: string) => {
      images.push(image);
    },
    setTitle: async () => {},
  };

  await internal.renderAgent({ action, slot: 0 });
  const titled = decodeURIComponent(images.at(-1)!);
  assert.match(titled, /Live chat/);
  assert.match(titled, /data-agent-host="O"/);
  assert.match(titled, /data-theme="light"/);

  delete task.displayTitle;
  internal.routedSlots = [openCodeTaskSlot(task, 0, Date.now(), host)];
  action.id = "opencode-alias";
  await internal.renderAgent({ action, slot: 0 });
  assert.match(decodeURIComponent(images.at(-1)!), /OpenCode 7/);
});

test("macOS usage source leaves theme unset when Codex has no renderer snapshot", () => {
  const controller = createController();
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
  sources(controller).codex.localHost = host;
  sources(controller).codex.localHealth = { state: "degraded", reason: "codex-not-running", changedAt: 1 };
  internal.codexBarUsage = {
    windows: [],
    observedAt: 2,
    resetCreditsAvailable: null,
    resetCreditsApplicable: null,
  };

  assert.equal(internal.accountUsageSource().theme, undefined);
});

test("pressing a terminal OpenCode task acknowledges that result after foregrounding", async () => {
  const order: string[] = [];
  const foregrounded: string[] = [];
  const acknowledged: string[] = [];
  const published: string[] = [];
  const controller = createController({
    foregroundOpenCode: async () => {
      order.push("foreground");
      foregrounded.push("foregrounded");
    },
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
  sources(controller).codex.localHost = host;
  (sources(controller).openCode as unknown as typeof internal).openCodeHealth = { state: "ready" };
  (sources(controller).openCode as unknown as typeof internal).openCodeCollector = {
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
    snapshot: () => ({ version: 1, observedAt: Date.now(), connections: [] }),
  };
  const terminalAt = Date.now();
  internal.routedSlots = [
    {
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
      observedAt: Date.now(),
    },
  ];

  const action = new Agent1(controller);
  const event = {
    action: { id: "first-key", showAlert: async () => assert.fail("API failure must remain best-effort") },
  };
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
    for (const [persisted, expected] of [
      [{}, false],
      [{ activeQueueEnabled: true }, true],
    ] as const) {
      settingsApi.getGlobalSettings = async () => persisted;
      const controller = createController();
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
  const controller = createController();
  const images: string[] = [];
  const action = {
    id: "empty-agent",
    setImage: async (image: string) => {
      images.push(image);
    },
    setTitle: async () => {},
  };
  const internal = controller as unknown as {
    activeQueueEnabled: boolean;
    localHost?: CodexHost;
    localHealth: { state: "ready" | "degraded" | "offline" | "connecting"; reason?: string };
    routedSlots: unknown[];
    renderAgent: (registration: { action: unknown; slot: number }) => Promise<void>;
  };
  internal.activeQueueEnabled = true;
  sources(controller).codex.localHost = host;
  internal.routedSlots = [];
  sources(controller).codex.localHealth = { state: "ready", changedAt: 1 };

  await internal.renderAgent({ action, slot: 0 });
  await internal.renderAgent({ action, slot: 0 });
  assert.equal(images.length, 1);
  assert.match(decodeURIComponent(images[0]!), /fill="#000000"/);

  const diagnostics = [
    { state: "degraded", title: /Signals[\s\S]*uncertain/ },
    { state: "offline", title: /Host[\s\S]*offline/ },
    { state: "connecting", title: /Connecting/ },
  ] as const;
  for (const diagnosticCase of diagnostics) {
    sources(controller).codex.localHealth = {
      state: diagnosticCase.state,
      reason: "local-bridge-unavailable",
      changedAt: 1,
    };
    await internal.renderAgent({ action, slot: 0 });
    const diagnostic = decodeURIComponent(images.at(-1)!);
    assert.match(diagnostic, diagnosticCase.title);
    assert.match(diagnostic, new RegExp(`data-agent-host-health="${diagnosticCase.state}"`));
    assert.doesNotMatch(diagnostic, /fill="#000000"\/>(?:<\/svg>)?$/);
  }
  assert.equal(images.length, 4);
});

test("only local codex-not-running blanks the first four Agent keys", async () => {
  const controller = createController();
  const internal = controller as unknown as {
    activeQueueEnabled: boolean;
    localHost?: CodexHost;
    localHealth: { state: "ready" | "degraded" | "offline" | "connecting"; reason?: string };
    routedSlots: RoutedAgentSlot[];
    renderAgent: (registration: { action: unknown; slot: number }) => Promise<void>;
  };
  internal.activeQueueEnabled = false;
  sources(controller).codex.localHost = host;
  internal.routedSlots = [];
  sources(controller).codex.localHealth = { state: "degraded", reason: "codex-not-running", changedAt: 1 };

  const render = async (slot: number): Promise<string> => {
    const images: string[] = [];
    await internal.renderAgent({
      slot,
      action: {
        id: `agent-${slot}`,
        setImage: async (image: string) => {
          images.push(image);
        },
        setTitle: async () => {},
      },
    });
    return decodeURIComponent(images.at(-1)!);
  };

  for (const slot of [0, 1, 2, 3]) {
    assert.match(await render(slot), /<rect width="144" height="144" fill="#000000"\/>/);
  }
  assert.match(await render(4), /Signals[\s\S]*uncertain/);

  sources(controller).codex.localHealth = { state: "ready", changedAt: 1 };
  assert.doesNotMatch(await render(0), /<rect width="144" height="144" fill="#000000"\/>/);

  sources(controller).codex.localHealth = { state: "degraded", reason: "local-bridge-unavailable", changedAt: 1 };
  assert.match(await render(0), /Signals[\s\S]*uncertain/);
});

for (const disappear of [false, true]) {
  test(`identical Agent instances isolate captured presses${disappear ? " after disappearance" : " across queue churn"}`, async () => {
    const controller = createController();
    const internal = controller as unknown as {
      localHost: CodexHost;
      routedSlots: RoutedAgentSlot[];
      microBridge: { sendAgent: (...args: unknown[]) => Promise<void> };
      refresh: () => Promise<void>;
    };
    sources(controller).codex.localHost = host;
    const original = { ...snapshot.slots[0]!, host, sourceSlot: 0, observedAt: 1_000 };
    const replacement = { ...snapshot.slots[1]!, host, sourceSlot: 1, observedAt: 2_000 };
    const sends: unknown[][] = [];
    sources(controller).codex.microBridge.sendAgent = async (...args) => {
      sends.push(args.slice(0, 3));
    };
    internal.refresh = async () => {};
    internal.routedSlots = [original];
    const action = new Agent1(controller);
    const event = (id: string) => ({
      action: {
        id,
        isKey: () => true,
        setImage: async () => {},
        setTitle: async () => {},
        showAlert: async () => {},
      },
    });
    const first = event("deck-one"),
      second = event("deck-two");
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
      [0, 1, original.threadKey],
      [1, 1, replacement.threadKey],
      ...(disappear ? [] : [[0, 0, original.threadKey]]),
      [1, 0, replacement.threadKey],
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
      "relay-server.json": JSON.stringify({
        enabled: true,
        listenHost: "127.0.0.1",
        port: 9,
        token: "test-private-token",
      }),
    };
    for (const [name, contents] of Object.entries(privateFiles)) await writeFile(join(stateRoot, name), contents);
    const scriptPath = join(root, "startup.mjs");
    const controllerUrl = pathToFileURL(
      fileURLToPath(new URL("../src/stream-deck/controller.ts", import.meta.url)),
    ).href;
    const actionsUrl = pathToFileURL(fileURLToPath(new URL("../src/stream-deck/actions.ts", import.meta.url))).href;
    const sdkUrl = import.meta.resolve("@elgato/streamdeck");
    await writeFile(
      scriptPath,
      `
      import assert from "node:assert/strict";
      import streamDeck from ${JSON.stringify(sdkUrl)};
      import { DeckController } from ${JSON.stringify(controllerUrl)};
      import { Agent1, HostToggle } from ${JSON.stringify(actionsUrl)};
      streamDeck.settings.getGlobalSettings = async () => ({ activeQueueEnabled: false });
      const { CodexSource } = await import(${JSON.stringify(new URL("../src/codex/index.ts", import.meta.url).href)});
      const { OpenCodeSource } = await import(${JSON.stringify(new URL("../src/opencode/index.ts", import.meta.url).href)});
      const controller = new DeckController({ codex: new CodexSource(() => {}), openCode: new OpenCodeSource(() => {}) });
      controller.sources.codex.microBridge.refresh = async () => (${JSON.stringify(snapshot)});
      const sends = [];
      controller.sources.codex.microBridge.sendAgent = async (...args) => { sends.push(args.slice(0, 3)); };
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
        assert.match(images.at(-1), /${identity.platform === "darwin" ? "MAC" : "WIN"}/);
        assert.match(images.at(-1), /data-host-health="ready"/);
        if (process.env.NEGATIVE_CONTROL) assert.fail("intentional assertion failure");
        const agent = new Agent1(controller);
        await agent.onKeyDown(event);
        await agent.onKeyUp(event);
        assert.deepEqual(sends, [[0, 1, ${JSON.stringify(snapshot.slots[0]!.threadKey)}], [0, 0, ${JSON.stringify(snapshot.slots[0]!.threadKey)}]]);
      process.stdout.write("LEGACY_STARTUP_SUCCESS\\n");
      } catch (error) { console.error(error); process.exitCode = 1; } finally { controller.stop(); }
    `,
    );
    for (const selection of ["darwin", "win32", "unknown"]) {
      const target = JSON.stringify({ platform: selection });
      await writeFile(join(stateRoot, "control-target.json"), target);
      const result = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), scriptPath], {
        cwd: root,
        env: { ...process.env, HOME: root, LOCALAPPDATA: root },
        encoding: "utf8",
        timeout: 15_000,
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.match(result.stdout, /LEGACY_STARTUP_SUCCESS/);
      const negative = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), scriptPath], {
        cwd: root,
        env: { ...process.env, HOME: root, LOCALAPPDATA: root, NEGATIVE_CONTROL: "1" },
        encoding: "utf8",
        timeout: 15_000,
      });
      assert.notEqual(negative.status, 0);
      assert.doesNotMatch(negative.stdout, /LEGACY_STARTUP_SUCCESS/);
      assert.match(negative.stderr, /intentional assertion failure/);
      assert.equal(await readFile(join(stateRoot, "control-target.json"), "utf8"), target);
      for (const [name, contents] of Object.entries(privateFiles))
        assert.equal(await readFile(join(stateRoot, name), "utf8"), contents);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a delayed OpenCode foreground receipt uses the saved revision and does not publish a rejected acknowledgement", async () => {
  let foregroundReady!: () => void;
  const foreground = new Promise<void>((resolve) => {
    foregroundReady = resolve;
  });
  const controller = createController({ foregroundOpenCode: () => foreground });
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
  sources(controller).codex.localHost = host;
  const original: RoutedAgentSlot = {
    ...snapshot.slots[0]!,
    taskSource: "opencode",
    host,
    threadKey: "connection\0session",
    sourceSlot: 0,
    status: "complete",
    activityAt: 100,
    observedAt: 1_000,
  };
  const newer = { ...original, activityAt: 200, observedAt: 2_000 };
  internal.routedSlots = [original];
  const receipts: unknown[][] = [];
  (sources(controller).openCode as unknown as typeof internal).openCodeCollector = {
    acknowledgeTask: (...args) => {
      receipts.push(args);
      return false;
    },
    publishTaskViewed: async () => assert.fail("rejected stale revision must not be published"),
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

test("usage buttons honor missing, stale and fresh CodexBar windows and preserve Windows renderer usage", async () => {
  const now = 1_800_000_000_000;
  const bar = (updatedAt: number) =>
    parseCodexBarUsage(
      { entries: [{ provider: "codex", updatedAt, primary: { usedPercent: 41, windowMinutes: 300 } }] },
      now,
    );
  for (const [platform, codexBar, expected] of [
    ["darwin", undefined, undefined],
    ["darwin", bar(now - CODEX_BAR_FRESH_MS - 1), undefined],
    ["darwin", bar(now), 41],
    ["win32", bar(now), 73],
  ] as const) {
    const controller = createController();
    const internal = controller as unknown as { codexBarUsage?: ReturnType<typeof bar> };
    sources(controller).codex.localHost = { ...host, platform };
    sources(controller).codex.localSnapshot = {
      host: sources(controller).codex.localHost!,
      snapshot: {
        ...snapshot,
        usage: {
          windows: [
            {
              id: "five-hour",
              kind: "five-hour",
              usedPercent: 73,
              remainingPercent: 27,
              windowDurationMins: 300,
              resetsAt: null,
            },
          ],
          observedAt: now,
          resetCreditsAvailable: null,
          resetCreditsApplicable: null,
        },
      },
      observedAt: now,
    };
    sources(controller).codex.localHealth = { state: "ready", changedAt: now };
    internal.codexBarUsage = codexBar;
    const images: string[] = [];
    const action = {
      id: platform,
      setImage: async (image: string) => {
        images.push(decodeURIComponent(image));
      },
      setTitle: async () => {},
    };
    controller.registerUsageLimit(action as never, "five-hour");
    await new Promise((resolve) => setImmediate(resolve));
    controller.registerUsageOverview(action as never);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(images.length, 2);
    for (const image of images) {
      if (expected === undefined) assert.doesNotMatch(image, /data-usage-used=/);
      else assert.match(image, new RegExp(`data-usage-used="${expected}"`));
      assert.match(image, /data-theme="dark"/);
    }
  }
});

for (const outcome of ["release", "disappear", "error", "activation-error"] as const) {
  test(`delayed native Agent refresh preserves captured phases on ${outcome}`, async () => {
    const controller = createController();
    const internal = controller as unknown as any;
    sources(controller).codex.localHost = host;
    internal.routedSlots = [{ ...snapshot.slots[0], host, sourceSlot: 0, observedAt: 1_000 }];
    const bridge = sources(controller).codex.microBridge as any;
    let finish!: () => void;
    const delayed = new Promise<void>((resolve) => {
      finish = resolve;
    });
    bridge.lastSnapshot = snapshot;
    bridge.refresh = async () => {
      await delayed;
      if (outcome === "error") throw new Error("fixture refresh failed");
      return snapshot;
    };
    const phases: number[] = [];
    bridge.dispatch = async (_type: string, payload: { event: { act: number } }) => {
      phases.push(payload.event.act);
    };
    bridge.ensureThreadActivated = async () => {
      if (outcome === "activation-error") throw new Error("fixture activation failed");
    };
    internal.refresh = async () => {};
    const down = controller.sendAgent(0, 1, { id: "slow" });
    const up = controller.sendAgent(0, 0, { id: "slow" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(phases, []);
    if (outcome === "disappear") controller.unregisterAgent({ id: "slow" });
    finish();
    if (outcome === "error" || outcome === "activation-error") {
      await assert.rejects(down, /fixture (refresh|activation) failed/);
      await up;
    } else await Promise.all([down, up]);
    assert.deepEqual(phases, outcome === "release" || outcome === "activation-error" ? [1, 0] : []);
  });
}

test("reasoning holds isolate button contexts and discard late generations", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const calls: string[] = [];
  let resolveOld!: () => void;
  let first = true;
  const controller = {
    adjustReasoning: async () => {
      calls.push("adjust");
      if (first) {
        first = false;
        await new Promise<void>((resolve) => {
          resolveOld = resolve;
        });
      }
    },
    unregisterFixedAction: () => {},
  } as unknown as DeckController;
  const action = new ReasoningUp(controller);
  const event = (id: string) => ({ action: { id, showAlert: async () => assert.fail("unexpected alert") } });
  const old = action.onKeyDown(event("A") as never);
  await action.onKeyDown(event("B") as never);
  assert.equal(calls.length, 2, "another button must act while A is awaiting");
  action.onKeyUp(event("B") as never);
  action.onKeyUp(event("A") as never);
  await action.onKeyDown(event("A") as never);
  resolveOld();
  await old;
  context.mock.timers.tick(499);
  assert.equal(calls.length, 3);
  context.mock.timers.tick(1);
  await Promise.resolve();
  assert.equal(calls.length, 4, "both contexts run and only the current A repeats after 500 ms");
  context.mock.timers.tick(299);
  assert.equal(calls.length, 4);
  context.mock.timers.tick(1);
  await Promise.resolve();
  assert.equal(calls.length, 5, "subsequent repeats wait 300 ms");
  action.onWillDisappear(event("A") as never);
  context.mock.timers.tick(1_000);
  assert.equal(calls.length, 5);
});

test("legacy reset key never spends credits on short, long, or disappearing presses", async (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const controller = createController();
  const internal = controller as unknown as { refresh: () => Promise<void> };
  sources(controller).codex.localHost = host;
  const usage = { windows: [], observedAt: Date.now(), resetCreditsAvailable: 1, resetCreditsApplicable: 1 };
  sources(controller).codex.localSnapshot = { host, snapshot: { ...snapshot, usage }, observedAt: Date.now() };
  let consumed = 0,
    alerts = 0,
    confirmed = 0;
  Object.assign(sources(controller).codex.microBridge, {
    consumeRateLimitReset: async () => {
      consumed++;
    },
  });
  internal.refresh = async () => {};
  const action = new RateLimitReset(controller);
  const event = {
    action: {
      id: "reset-key",
      isKey: () => true,
      setImage: async () => {},
      setTitle: async () => {},
      showAlert: async () => {
        alerts++;
      },
      showOk: async () => {
        confirmed++;
      },
    },
  };
  action.onWillAppear(event as never);
  action.onKeyDown?.(event as never);
  context.mock.timers.tick(1_199);
  await action.onKeyUp?.(event as never);
  assert.equal(consumed, 0);
  action.onKeyDown?.(event as never);
  context.mock.timers.tick(1_200);
  action.onWillDisappear(event as never);
  await action.onKeyUp?.(event as never);
  assert.equal(consumed, 0);
  action.onWillAppear(event as never);
  for (const [available, applicable] of [
    [0, 1],
    [1, 0],
    [1, 1],
  ] as const) {
    usage.resetCreditsAvailable = available;
    usage.resetCreditsApplicable = applicable;
    action.onKeyDown?.(event as never);
    context.mock.timers.tick(1_200);
    await action.onKeyUp?.(event as never);
  }
  assert.equal(consumed, 0, "presses must never spend reset credits");
  assert.equal(alerts, 0);
  assert.equal(confirmed, 0);
});

test("an empty Agent press queued behind a prior pair captures its no-op before settings change", async () => {
  const controller = createController();
  const internal = controller as unknown as {
    activeQueueEnabled: boolean;
    routedSlots: RoutedAgentSlot[];
    refresh: () => Promise<void>;
  };
  const original = { ...snapshot.slots[0]!, host, sourceSlot: 0, observedAt: 1_000 };
  internal.routedSlots = [original];
  internal.activeQueueEnabled = true;
  internal.refresh = async () => {};
  let finish!: () => void;
  const delayed = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const phases: unknown[][] = [];
  sources(controller).codex.microBridge.sendAgent = async (...args) => {
    if (args[1] === 1) await delayed;
    phases.push(args.slice(0, 3));
  };
  const down = controller.sendAgent(0, 1, { id: "queued" });
  const up = controller.sendAgent(0, 0, { id: "queued" });
  internal.routedSlots = [];
  const emptyDown = controller.sendAgent(0, 1, { id: "queued" });
  internal.activeQueueEnabled = false;
  internal.routedSlots = [{ ...snapshot.slots[1]!, host, sourceSlot: 1, observedAt: 2_000 }];
  const emptyUp = controller.sendAgent(0, 0, { id: "queued" });
  finish();
  await Promise.all([down, up, emptyDown, emptyUp]);
  assert.deepEqual(phases, [
    [0, 1, original.threadKey],
    [0, 0, original.threadKey],
  ]);
});
