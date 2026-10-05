import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createContext, runInContext, runInNewContext, type Context } from "node:vm";
import {
  ACTIVE_CATALOG_RETRY_DELAY_MS,
  buildActiveCatalogDiscoveryExpression,
  buildSnapshotPayloadExpression
} from "#codex";
import {
  buildEnsureThreadActivatedExpression, canonicalThreadId, CodexMicroRendererBridge, CodexNotRunningError, hasMacCodexExecutable, localBridgeFailureReason, macCodexExecutablePathFromWatcherState, nativeActionKey, REASONING_ENCODER_KEYS, resolveAgentDispatch,
  retainEvaluationPromise, selectCodexMainTarget, selectSidebarThreadId, threadKeysEquivalent
} from "#codex";
import { ADDITIONAL_KEYCAPS, OFFICIAL_KEYCAP_IDS } from "#codex";
import { visualStatusFromMicro } from "#agents";
import type { MicroSnapshot } from "#agents";

test("official Micro statuses map to the Stream Deck color states", () => {
  assert.equal(visualStatusFromMicro("off"), "empty");
  assert.equal(visualStatusFromMicro("working"), "thinking");
  assert.equal(visualStatusFromMicro("thinking"), "thinking");
  assert.equal(visualStatusFromMicro("unread"), "complete");
  assert.equal(visualStatusFromMicro("done"), "complete");
  assert.equal(visualStatusFromMicro("approval"), "input");
  assert.equal(visualStatusFromMicro("awaiting-approval"), "input");
  assert.equal(visualStatusFromMicro("awaiting-response"), "input");
  assert.equal(visualStatusFromMicro("error"), "error");
  assert.equal(visualStatusFromMicro("idle"), "idle");
});

test("only an explicit stopped-Codex marker suppresses local bridge diagnostics", () => {
  assert.equal(localBridgeFailureReason(new CodexNotRunningError()), "codex-not-running");
  assert.equal(localBridgeFailureReason(new Error("temporary bridge failure")), "local-bridge-unavailable");
});

test("macOS watcher state excludes CodexBar false positives before bridge discovery", () => {
  const codexExecutable = "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT";
  assert.equal(macCodexExecutablePathFromWatcherState(`{"lastGeneration":"123:Sat Aug 22 16:03:23 2026:${codexExecutable}"}`), codexExecutable);
  assert.equal(macCodexExecutablePathFromWatcherState('{"lastGeneration":null}'), null);
  assert.equal(macCodexExecutablePathFromWatcherState('{"lastGeneration":123}'), undefined);
  assert.equal(hasMacCodexExecutable(["/Applications/CodexBar.app/Contents/MacOS/CodexBar"], codexExecutable), false);
  assert.equal(hasMacCodexExecutable([codexExecutable], codexExecutable), true);
  assert.equal(
    hasMacCodexExecutable([`${codexExecutable} --remote-debugging-address=127.0.0.1 --remote-debugging-port=43123`], codexExecutable),
    true
  );
});

test("official keycap SVG contents are not bundled in the public source", async () => {
  const controller = await readFile(new URL("../src/stream-deck/controller.ts", import.meta.url), "utf8");
  assert.match(controller, /codexDeckStateRoot\(\)[\s\S]*icons/);
  assert.doesNotMatch(controller, /static\/imgs\/official/);
});

test("renderer bridge uses native Micro events and discovers hashed modules at runtime", async () => {
  const bridgeSource = await readFile(new URL("../src/codex/bridge.ts", import.meta.url), "utf8");
  const catalogSource = await readFile(new URL("../src/codex/active-catalog-expression.ts", import.meta.url), "utf8");
  const source = `${bridgeSource}\n${catalogSource}`;
  for (const eventName of ["codex-micro-device-state-changed", "codex-micro-hid-event", "codex-micro-joystick-event"]) {
    assert.match(source, new RegExp(eventName));
  }
  assert.match(source, /link\[href\], script\[src\]/);
  assert.match(source, /performance\.getEntriesByType\('resource'\)/);
  assert.match(source, /createSubscriberAtom/);
  assert.match(source, /slots\.length === 6/);
  assert.match(source, /codex-micro-agent-source/);
  assert.match(source, /data-app-action-sidebar-thread-id/);
  assert.match(source, /activeThreadKey/);
  assert.match(source, /data-above-composer-conversation-id/);
  assert.match(source, /data-app-action-sidebar-thread-active/);
  assert.match(source, /directSettingReader/);
  assert.match(source, /app-initial-/);
  assert.match(source, /allSidebarThreadKeys/);
  assert.match(source, /pinnedThreadKeys/);
  assert.match(source, /unpinnedThreadKeys/);
  assert.match(source, /threadAttentionStateByKey/);
  assert.match(source, /threadRecencyAtByKey/);
  assert.match(source, /threadRuntimeStatus/);
  assert.match(source, /hasUnreadTurn/);
  assert.match(source, /task_status_display/);
  assert.match(source, /latest_turn_status_display/);
  assert.match(source, /has_unread_turn/);
  assert.match(source, /task\?\.conversation_id \?\? task\?\.id/);
  assert.match(source, /family\.resolve\(found\.node, found\.chain, key\)/);
  assert.match(source, /codex-deck-active-catalog-resolvers/);
  assert.match(source, /allSidebarResolver/);
  assert.match(source, /readableFamily/);
  assert.match(source, /resolverCache\.taskFamily/);
  assert.match(source, /retryAt: Date\.now\(\)/);
  assert.match(source, /const remoteTaskStatus =/);
  assert.match(source, /TextEncoder/);
  assert.match(source, /get-setting/);
  assert.match(source, /found\.node\.store\.get\.bind\(found\.node\.store\)/);
  assert.doesNotMatch(source, /candidate\?\.token === appScope/);
  assert.doesNotMatch(source, /D90_rd6W|SFcKxWqG|DJFcGyy5/);
  assert.ok(bridgeSource.split("\n").length < 1000, "renderer bridge should keep catalog discovery extracted");
});

type CatalogHarness = {
  context: Context & Record<string | symbol, unknown>;
  descriptors: Map<string, unknown>;
  descriptorCalls: string[];
  setKeys: (keys: string[]) => void;
  setNamespace: (namespace: Record<string, unknown>) => void;
  useValidNamespace: () => void;
  poll: () => Promise<Record<string, unknown>>;
};

const catalogKey = (index: number): string =>
  `local:10000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;

function createCatalogHarness(initialKeys: string[], sidebarShape: "legacy" | "split" = "legacy"): CatalogHarness {
  const descriptorCalls: string[] = [];
  const descriptors = new Map<string, unknown>();
  const state = {
    allSidebar: { allSidebarThreadKeys: [] as string[], pinnedThreadKeys: [] as string[], unpinnedThreadKeys: [] as string[] },
    readable: {} as Record<string, unknown>
  };
  const atoms = new Map<unknown, unknown>();
  const allSidebarResolver = { resolve: () => "all-sidebar", createSubscriberAtom: () => null };
  const readableFamily = {
    resolve: (_node: unknown, _chain: unknown, key: string) => ({ resolve: () => key === "codex" ? "readable" : "missing" })
  };
  const taskFamily = {
    resolve: (_node: unknown, _chain: unknown, key: string) => {
      if (key !== "codex") descriptorCalls.push(key);
      return { resolve: () => `task:${key}` };
    }
  };
  const lightweightFamily = {
    resolve: (_node: unknown, _chain: unknown, key: string) => ({ resolve: () => `metadata:${key}` })
  };
  const validNamespace: Record<string, unknown> = {
    ...(sidebarShape === "split" ? { lightweightFamily } : {}),
    allSidebarResolver, readableFamily, taskFamily
  };
  let namespace = validNamespace;
  let loaderCalls = 0;
  const context = createContext({
    TextEncoder,
    Symbol,
    Map,
    Set,
    Date: { now: () => context.now },
    now: 1_000,
    urls: ["app://-/assets/app-initial-a.js"],
    slots: Array.from({ length: 6 }, (_, id) => ({
      id, threadKey: null, title: `Native ${id}`, status: "idle", selected: false
    })),
    loadModule: async () => { loaderCalls += 1; return namespace; },
    get loaderCalls() { return loaderCalls; },
    storeGet: (atom: unknown) => {
      if (atom === "all-sidebar") return state.allSidebar;
      if (atom === "readable") return state.readable;
      if (typeof atom === "string" && atom.startsWith("task:")) return descriptors.get(atom.slice(5));
      if (typeof atom === "string" && atom.startsWith("metadata:")) {
        const key = atom.slice(9);
        return descriptors.has(key) ? { kind: "local", key, conversationId: key.slice(-36) } : null;
      }
      return atoms.get(atom);
    }
  }) as Context & Record<string | symbol, unknown>;

  const setKeys = (keys: string[]): void => {
    state.allSidebar = {
      allSidebarThreadKeys: [...keys],
      pinnedThreadKeys: keys.slice(0, 1),
      unpinnedThreadKeys: keys.slice(1)
    };
    state.readable = sidebarShape === "split" ? {
      threadKeys: [...keys], threadStateKeys: [...keys], navigationThreadKeys: [...keys]
    } : {
      threadKeys: [...keys],
      threadAttentionStateByKey: new Map(keys.map((key, index) => [key, index === 1 ? "waiting" : "idle"])),
      threadRecencyAtByKey: new Map(keys.map((key, index) => [key, 1_000 + index]))
    };
    descriptors.clear();
    for (const [index, key] of keys.entries()) {
      descriptors.set(key, {
        kind: "local", key,
        conversation: { id: key.slice(-36), title: `Task ${index}`, threadRuntimeStatus: { type: index === 0 ? "active" : "idle" } }
      });
    }
  };
  setKeys(initialKeys);

  const expression = `(async () => {
    const urls = globalThis.urls;
    const found = { node: { store: { get: globalThis.storeGet } }, chain: new Map() };
    const slots = globalThis.slots;
    const toEpoch = (value) => typeof value === 'number' ? value : undefined;
    ${buildActiveCatalogDiscoveryExpression("(url) => globalThis.loadModule(url)")}
    return ${buildSnapshotPayloadExpression("{ slots, marker: 'base-six' }")};
  })()`;

  return {
    context,
    descriptors,
    descriptorCalls,
    setKeys,
    setNamespace: (value) => { namespace = value; },
    useValidNamespace: () => { namespace = validNamespace; },
    poll: () => runInContext(expression, context) as Promise<Record<string, unknown>>
  };
}

test("active catalog discovery executes semantic normalization and preserves native status priority", async () => {
  const keys = [catalogKey(1), catalogKey(2), catalogKey(3)];
  const harness = createCatalogHarness(keys);
  const result = await harness.poll() as { activeCatalog?: { complete: boolean; candidates: Array<Record<string, unknown>> } };

  assert.equal(result.activeCatalog?.complete, true);
  assert.deepEqual(Array.from(result.activeCatalog?.candidates ?? [], ({ threadKey }) => threadKey), [keys[1], keys[0], keys[2]]);
  assert.equal(result.activeCatalog?.candidates[0]?.status, "awaiting-response");
  assert.equal(result.activeCatalog?.candidates[1]?.status, "working");
});

test("split sidebar state keeps working chats beyond the six native slots with trusted identities", async () => {
  const keys = Array.from({ length: 8 }, (_, index) => catalogKey(index));
  const harness = createCatalogHarness(keys, "split");
  for (const [index, key] of keys.entries()) {
    harness.descriptors.set(key, {
      kind: "local", key,
      summary: {
        conversationId: key.slice(-36), hostId: index === 6 ? "remote-host" : "local",
        title: `Task ${index}`, recencyAt: 2_000 + index,
        threadRuntimeStatus: { type: index === 0 || index === 6 ? "active" : "idle" },
        hasUnreadTurn: index === 7
      }
    });
  }
  (harness.context.slots as Array<Record<string, unknown>>)[0] = {
    id: 0, threadKey: keys[0], title: "Native task", status: "awaiting-approval", selected: true
  };
  for (let poll = 0; poll < 3; poll += 1) {
    if (poll === 2) {
      // Installing the new plugin must not inherit the old renderer's failure
      // entry, even though the Codex app bundle itself has not changed.
      harness.context[Symbol.for("codex-deck-active-catalog-resolvers")] = {
        url: (harness.context.urls as string[])[0], failure: true, retryAt: 1_000_000
      };
    }
    const result = await harness.poll() as { activeCatalog?: { complete: boolean; candidates: Array<Record<string, unknown>> } };
    assert.equal(result.activeCatalog?.complete, true);
    const candidates = result.activeCatalog!.candidates;
    assert.equal(candidates.length, 8);
    assert.deepEqual(Array.from(candidates.filter((item) => item.status !== "idle"), (item) => item.threadKey),
      [keys[7], keys[6], keys[0]]);
    const outsideNative = candidates.find((item) => item.threadKey === keys[6])!;
    assert.equal(outsideNative.status, "working");
    assert.equal(outsideNative.title, "Task 6");
    assert.equal(outsideNative.conversationId, keys[6]!.slice(-36));
    assert.equal(outsideNative.activityAt, 2_006);
    assert.equal(outsideNative.nativeSlot, undefined);
    assert.equal(candidates.find((item) => item.threadKey === keys[0])?.status, "awaiting-approval");
  }
});

test("more than 256 exact keys fail closed before per-key descriptor resolution", async () => {
  const harness = createCatalogHarness(Array.from({ length: 257 }, (_, index) => catalogKey(index)));
  const result = await harness.poll() as { slots: unknown[]; activeCatalog?: unknown; marker?: string };

  assert.equal(result.activeCatalog, undefined);
  assert.equal(result.slots.length, 6);
  assert.equal(result.marker, "base-six");
  assert.equal(harness.descriptorCalls.length, 0);
  const cache = harness.context[Symbol.for("codex-deck-active-catalog-resolvers")] as { failure?: boolean };
  assert.notEqual(cache.failure, true, "live catalog size must not poison semantic resolver discovery");
  harness.setKeys([catalogKey(1)]);
  assert.ok((await harness.poll()).activeCatalog, "a smaller next poll should be reconsidered immediately");
});

test("resolver incompatibility is negatively cached, then URL changes retry immediately", async () => {
  const harness = createCatalogHarness([catalogKey(1)]);
  harness.setNamespace({ incompatible: true });

  await harness.poll();
  await harness.poll();
  assert.equal(harness.context.loaderCalls, 1, "same URL should respect the retry deadline");

  harness.context.urls = ["app://-/assets/app-initial-b.js"];
  await harness.poll();
  assert.equal(harness.context.loaderCalls, 2, "a new app bundle must invalidate the failure immediately");
});

test("resolver failure retries after the deadline and success clears the failure entry", async () => {
  const key = catalogKey(1);
  const harness = createCatalogHarness([key]);
  harness.setNamespace({ incompatible: true });
  await harness.poll();

  harness.context.now = 1_000 + ACTIVE_CATALOG_RETRY_DELAY_MS;
  harness.useValidNamespace();
  const result = await harness.poll() as { activeCatalog?: unknown };

  assert.ok(result.activeCatalog);
  const cache = harness.context[Symbol.for("codex-deck-active-catalog-resolvers")] as { failure?: boolean };
  assert.notEqual(cache.failure, true);
});

test("a transient descriptor miss omits one poll, retains success cache, and retries immediately", async () => {
  const keys = [catalogKey(1), catalogKey(2)];
  const harness = createCatalogHarness(keys);
  assert.ok((await harness.poll()).activeCatalog);
  const cacheKey = Symbol.for("codex-deck-active-catalog-resolvers");
  const successCache = harness.context[cacheKey];

  harness.descriptors.delete(keys[1]!);
  const missed = await harness.poll() as { slots: unknown[]; activeCatalog?: unknown };
  assert.equal(missed.activeCatalog, undefined);
  assert.equal(missed.slots.length, 6);
  assert.equal(harness.context[cacheKey], successCache);

  harness.descriptors.set(keys[1]!, {
    kind: "local", key: keys[1], conversation: { id: keys[1]!.slice(-36), title: "Restored" }
  });
  assert.ok((await harness.poll()).activeCatalog, "next poll should retry without resolver backoff");
});

test("64 KiB snapshot budget omits the optional catalog without truncating the base snapshot", async () => {
  const keys = Array.from({ length: 256 }, (_, index) => catalogKey(index));
  const harness = createCatalogHarness(keys);
  for (const [key, descriptor] of harness.descriptors) {
    (descriptor as { conversation: { title: string } }).conversation.title = "🚀".repeat(120);
    harness.descriptors.set(key, descriptor);
  }
  const result = await harness.poll() as { slots: unknown[]; marker?: string; activeCatalog?: unknown };

  assert.equal(result.activeCatalog, undefined);
  assert.equal(result.marker, "base-six");
  assert.equal(result.slots.length, 6);
});

test("renderer bridge prefers the main index document over macOS avatar surfaces", () => {
  const target = selectCodexMainTarget([
    { type: "page", url: "app://-/index.html?initialRoute=%2Favatar-overlay", webSocketDebuggerUrl: "ws://route" },
    { type: "page", url: "app://-/avatar-overlay-composition-surface.html?surfaceId=mascot-badge", webSocketDebuggerUrl: "ws://mascot" },
    { type: "page", url: "app://-/avatar-overlay-composition-surface.html?surfaceId=activity-slot-0", webSocketDebuggerUrl: "ws://slot" },
    { type: "page", url: "app://-/index.html", webSocketDebuggerUrl: "ws://main" }
  ]);

  assert.equal(target?.webSocketDebuggerUrl, "ws://main");
});

test("renderer bridge rejects auxiliary-only renderer lists", () => {
  const target = selectCodexMainTarget([
    { type: "page", url: "app://-/avatar-overlay-composition-surface.html?surfaceId=mascot-badge", webSocketDebuggerUrl: "ws://mascot" }
  ]);

  assert.equal(target, undefined);
});

test("renderer evaluations retain their awaited promise until CDP has collected the result", () => {
  const expression = retainEvaluationPromise("(async () => true)()", 17);
  assert.match(expression, /__codexDeckPendingEvaluations/);
  assert.match(expression, /codex-deck-17/);
  assert.match(expression, /Promise\.resolve/);
  assert.match(expression, /setTimeout\(\(\) => store\.delete/);
  const namespaced = retainEvaluationPromise("Promise.resolve(true)", "bridge-a-1");
  assert.match(namespaced, /codex-deck-bridge-a-1/);
});

test("renderer thread comparisons accept bare IDs without conflating host-prefixed mirrors", () => {
  const threadId = "019fc4e4-4ecc-7f20-b7f5-855c11da7b37";
  const local = `local:${threadId}`;
  const remote = `remote-ssh-codex-managed:mlgpu:${threadId}`;

  assert.equal(canonicalThreadId(threadId), threadId);
  assert.equal(canonicalThreadId(local), threadId);
  assert.equal(canonicalThreadId(remote), threadId);
  assert.equal(threadKeysEquivalent(local, threadId), true);
  assert.equal(threadKeysEquivalent(remote, threadId), true);
  assert.equal(threadKeysEquivalent(local, remote), false);
  assert.equal(selectSidebarThreadId(local, [threadId]), threadId);
  assert.equal(selectSidebarThreadId(remote, [local, remote]), remote);
  assert.equal(selectSidebarThreadId(threadId, [local]), local);
  assert.equal(selectSidebarThreadId(threadId, [local, local]), local);
  assert.equal(selectSidebarThreadId(threadId, [local, remote]), undefined);
});

async function evaluateThreadActivation(
  threadKey: string,
  sidebarThreadIds: string[],
  activeSidebarThreadId: string | null,
  composerThreadId: string | null,
  composerVisible = true
): Promise<unknown> {
  const element = (id: string) => ({
    getAttribute: (name: string) => name === "data-app-action-sidebar-thread-id" || name === "data-above-composer-conversation-id" ? id : null,
    getClientRects: () => composerVisible ? [{}] : [],
    matches: () => false,
    querySelector: () => null,
    closest: () => null,
    click: () => {}
  });
  const sidebarElements = sidebarThreadIds.map(element);
  let now = 0;
  return runInNewContext(buildEnsureThreadActivatedExpression(threadKey), {
    Date: { now: () => now },
    document: {
      querySelector: (selector: string) => {
        if (selector.includes('data-app-action-sidebar-thread-active="true"')) {
          return activeSidebarThreadId ? element(activeSidebarThreadId) : null;
        }
        if (selector.includes('aria-current="page"')) return null;
        if (selector.includes("data-above-composer-conversation-id")) {
          return composerThreadId ? element(composerThreadId) : null;
        }
        return null;
      },
      querySelectorAll: (selector: string) => selector.includes("data-above-composer")
        ? composerThreadId ? [element(composerThreadId)] : [] : sidebarElements
    },
    setTimeout: (callback: () => void, duration: number) => {
      now += duration;
      queueMicrotask(callback);
    }
  }) as Promise<unknown>;
}

test("thread activation evaluator preserves host identity across sidebar and composer state", async () => {
  const threadId = "019fc4e4-4ecc-7f20-b7f5-855c11da7b37";
  const local = `local:${threadId}`;
  const remote = `remote:${threadId}`;

  assert.equal(await evaluateThreadActivation(threadId, [local, remote], null, threadId), "missing");
  assert.equal(await evaluateThreadActivation(local, [local, remote], null, threadId), "failed");
  assert.equal(await evaluateThreadActivation(local, [local, remote], local, threadId), "active");
  assert.equal(await evaluateThreadActivation(threadId, [local], null, threadId), "active");
  assert.equal(await evaluateThreadActivation(threadId, [local, local], local, threadId), "active");
  assert.equal(await evaluateThreadActivation(local, [], null, local), "active");
  assert.equal(await evaluateThreadActivation(local, [], null, local, false), "missing");
});

test("native action 5 maps the combined layout slot to Codex push-to-talk", () => {
  assert.equal(nativeActionKey("ACT10_ACT11"), "ACT10");
  assert.equal(nativeActionKey("ACT06"), "ACT06");
});

test("remote MIC keycaps use the native push-to-talk press/release sequence", async () => {
  const bridge = new CodexMicroRendererBridge(() => {});
  const actions: Array<Parameters<CodexMicroRendererBridge["sendAction"]>> = [];
  bridge.sendAction = async (...args) => { actions.push(args); };

  await bridge.runKeycap("MIC");
  assert.deepEqual(actions, [
    ["ACT10_ACT11", 1],
    ["ACT10_ACT11", 0]
  ]);
});

test("agent routing follows the stable thread identity when a cross-host slot is stale", () => {
  const snapshot = {
    slots: Array.from({ length: 6 }, (_, id) => ({
      id,
      threadKey: `local:00000000-0000-4000-8000-00000000000${id}`,
      title: `Task ${id}`,
      status: "idle",
      selected: false
    })),
    layout: {
      version: 1,
      slots: {
        ACT06: { keycapId: "FAST" }, ACT07: { keycapId: "APPR" },
        ACT08: { keycapId: "REJ" }, ACT09: { keycapId: "SPLIT" },
        ACT10_ACT11: { keycapId: "CODEX" }, ACT12: { keycapId: "CODEX" }
      },
      analogStick: { up: {}, right: {}, down: {}, left: {} }
    },
    agentSource: "priority",
    lightingAutoOff: "3-minutes",
    theme: "dark"
  } as MicroSnapshot;
  const movedThread = snapshot.slots[4]!.threadKey!;
  assert.deepEqual(resolveAgentDispatch(snapshot, 2, movedThread), {
    kind: "native", slot: 4, threadKey: movedThread
  });
  const offDeckThread = "local:10000000-0000-4000-8000-000000000099";
  assert.deepEqual(resolveAgentDispatch(snapshot, 2, offDeckThread), {
    kind: "direct", slot: 2, threadKey: offDeckThread
  });
});

test("direct off-six and pinned dispatch send exact thread keys and release remains a no-op", async () => {
  const bridge = new CodexMicroRendererBridge(() => {});
  const base = {
    slots: Array.from({ length: 6 }, (_, id) => ({
      id, threadKey: `local:00000000-0000-4000-8000-00000000000${id}`,
      title: `Task ${id}`, status: "idle", selected: false
    })),
    layout: { version: 1, slots: {
      ACT06: { keycapId: "FAST" }, ACT07: { keycapId: "APPR" }, ACT08: { keycapId: "REJ" },
      ACT09: { keycapId: "SPLIT" }, ACT10_ACT11: { keycapId: "CODEX" }, ACT12: { keycapId: "CODEX" }
    }, analogStick: { up: {}, right: {}, down: {}, left: {} } },
    agentSource: "recent", lightingAutoOff: "3-minutes", theme: "dark"
  } as MicroSnapshot;
  const events: unknown[] = [];
  const internal = bridge as unknown as {
    refresh: () => Promise<MicroSnapshot>;
    dispatch: (type: string, payload: object, handler: string) => Promise<void>;
    ensureThreadActivated: () => Promise<void>;
  };
  internal.refresh = async () => base;
  internal.dispatch = async (_type, payload) => { events.push(payload); };
  internal.ensureThreadActivated = async () => { throw new Error("DOM fallback must not run"); };
  const exact = "local:client-new-thread:10000000-0000-4000-8000-000000000099";

  await bridge.sendAgent(5, 1, exact);
  await bridge.sendAgent(5, 0, exact);

  base.agentSource = "pinned";
  const pinned = base.slots[2]!.threadKey!;
  await bridge.sendAgent(2, 1, pinned);
  await bridge.sendAgent(2, 0, pinned);
  assert.deepEqual(events, [
    { event: { key: "AG05", act: 1, slot: 5, threadKey: exact } },
    { event: { key: "AG02", act: 1, slot: 2, threadKey: pinned } }
  ]);
});

test("reasoning controls use the official native encoder rotation events", async () => {
  assert.deepEqual(REASONING_ENCODER_KEYS, {
    decrease: "ENC_CW",
    increase: "ENC_CC"
  });
  const source = await readFile(new URL("../src/codex/bridge.ts", import.meta.url), "utf8");
  assert.match(source, /act: 2/);
  assert.match(source, /codex-micro-hid-event/);
});

test("manifest exposes both dedicated reasoning adjustment buttons", async () => {
  const manifest = JSON.parse(await readFile(new URL("../static/manifest.json", import.meta.url), "utf8")) as { Actions: Array<{ UUID: string }>; OS: Array<{ Platform: string }> };
  const actions = new Set(manifest.Actions.map((action) => action.UUID));
  assert.equal(actions.has("com.xonika9.codex-deck.reasoning-down"), true);
  assert.equal(actions.has("com.xonika9.codex-deck.reasoning-up"), true);
  assert.equal(actions.has("com.xonika9.codex-deck.host-toggle"), true);
  assert.deepEqual(manifest.OS.map(({ Platform }) => Platform).sort(), ["mac", "windows"]);
});

test("all official keycaps are covered by standalone or native actions", async () => {
  const manifest = JSON.parse(await readFile(new URL("../static/manifest.json", import.meta.url), "utf8")) as { Actions: Array<{ UUID: string }> };
  const actions = new Set(manifest.Actions.map((action) => action.UUID));
  for (const keycap of ADDITIONAL_KEYCAPS) {
    assert.equal(actions.has(`com.xonika9.codex-deck.keycap-${keycap.slug}`), true, `missing ${keycap.id}`);
  }
  assert.equal(OFFICIAL_KEYCAP_IDS.length, 30);
  assert.equal(new Set(ADDITIONAL_KEYCAPS.map((keycap) => keycap.id)).size, 29);
  assert.equal(actions.has("com.xonika9.codex-deck.dictation"), true, "MIC uses the native press/release action");
});

test("standalone keycaps resolve Codex's live registry instead of hardcoding commands", async () => {
  const source = await readFile(new URL("../src/codex/bridge.ts", import.meta.url), "utf8");
  assert.match(source, /codex-micro-layout-/);
  assert.match(source, /keycapGetter/);
  assert.match(source, /codex-micro-bridge-/);
  assert.match(source, /runnerLocal/);
  assert.match(source, /\\\\w/);
  assert.match(source, /import\\\\s/);
  assert.match(source, /codex_micro_hid/);
});

test("controller avoids overlapping polls and redundant image writes", async () => {
  const source = await readFile(new URL("../src/stream-deck/controller.ts", import.meta.url), "utf8");
  assert.match(source, /lastImages/);
  assert.match(source, /this\.lastImages\.get\(action\.id\) === image/);
  assert.match(source, /scheduleRefresh/);
  assert.match(source, /status === "thinking" \|\| status === "input"/);
  assert.doesNotMatch(source, /if \(act === 1\) await this\.refresh\(\)/);
  assert.doesNotMatch(source, /setInterval\(/);
});

test("assigned titleless threads use a new-chat label instead of Not assigned", async () => {
  const source = await readFile(new URL("../src/stream-deck/controller.ts", import.meta.url), "utf8");
  assert.match(source, /agent\?\.threadKey\s*&&\s*health\.state\s*===\s*"ready"\s*\?\s*"New chat"/);
  assert.match(source, /:\s*"Not assigned"/);
});

test("renderer snapshot uses live pinned rows, caches collapsed pins and ignores hidden composers", async () => {
  let expression = "";
  const bridge = new CodexMicroRendererBridge(() => {});
  const internal = bridge as unknown as {
    ensureConnected: () => Promise<void>;
    evaluate: (expression: string) => Promise<MicroSnapshot>;
  };
  internal.ensureConnected = async () => {};
  internal.evaluate = async (value) => { expression = value; throw new Error("snapshot captured"); };
  await assert.rejects(bridge.refresh(), /snapshot captured/);

  const nativeSlots = Array.from({ length: 6 }, (_, id) => ({
    id, threadKey: catalogKey(id), title: `Old pin ${id}`, status: "idle", selected: false, activityAt: 42
  }));
  const definitions = {
    layout: { key: "codex-micro-layout", default: { version: 1, slots: {} } },
    agentSource: { key: "codex-micro-agent-source", default: "pinned" }
  };
  const slotResolver = { resolve: () => "slots", createSubscriberAtom: () => null };
  let semanticPinsEmpty = false;
  const store = { get: (atom: unknown) => atom === "slots" ? nativeSlots
    : semanticPinsEmpty && atom === "sidebar" ? { allSidebarThreadKeys: [], pinnedThreadKeys: [], unpinnedThreadKeys: [] }
    : semanticPinsEmpty && atom === "readable" ? { threadKeys: [], threadStateKeys: [], navigationThreadKeys: [] }
    : null };
  const root = { __reactContainer$test: { memoizedProps: { value: new Map([["node", { store }]]) } } };
  const row = (key: string, status: object) => ({
    getAttribute: (name: string) => ({
      "data-app-action-sidebar-thread-id": key,
      "data-app-action-sidebar-thread-title": `Live ${key}`,
      "data-app-action-sidebar-thread-active": key === active ? "true" : "false"
    } as Record<string, string>)[name] ?? null,
    __reactFiber$test: { return: { memoizedProps: { statusState: status } } }
  });
  let rows: ReturnType<typeof row>[] = [];
  let active: string | null = null;
  let composers = [
    { getAttribute: () => catalogKey(90), getClientRects: () => [] },
    { getAttribute: () => catalogKey(91), getClientRects: () => [{}] }
  ];
  const resources = [{ name: "app://-/assets/codex-micro-slot-signals-test.js" }];
  const context = createContext({
    Map, Set, Symbol, TextEncoder,
    document: {
      getElementById: () => root,
      documentElement: { dataset: {}, className: "" },
      body: { dataset: {}, className: "" },
      querySelectorAll: (selector: string) => selector.includes("thread-pinned") ? rows
        : selector.includes("data-above-composer") ? composers : [],
      querySelector: (selector: string) => selector.includes('thread-active="true"') && active
        ? { getAttribute: () => active } : selector.includes("data-above-composer") ? composers[0] : null
    },
    performance: { getEntriesByType: () => resources },
    getComputedStyle: () => ({ colorScheme: "dark", backgroundColor: "rgb(0,0,0)" }),
    loadModule: async () => ({ definitions, slotResolver,
      allSidebarResolver: { resolve: () => "sidebar", createSubscriberAtom: () => null },
      readableFamily: { resolve: () => ({ resolve: () => "readable" }) },
      bus: {
        handlers: new Map([["codex-micro-hid-event", new Set([() => {}])]]), dispatchHostMessage: () => {}
      } })
  });
  const poll = async (): Promise<MicroSnapshot> => JSON.parse(JSON.stringify(
    await runInContext(expression.replaceAll("import(", "loadModule("), context)
  ));
  // Older sidebar markup has no pinned rows: native slots still work.
  let snapshot = await poll();
  assert.deepEqual(snapshot.slots.map(slot => slot.threadKey), nativeSlots.map(slot => slot.threadKey));

  const states = [
    { type: "loading" }, { type: "error" }, { type: "approval" },
    { type: "response" }, { type: "idle", unread: true }, { type: "idle" }
  ];
  rows = states.map((state, index) => row(catalogKey(5 - index), state));
  rows.splice(1, 0, rows[0]!);
  rows.push(row(catalogKey(7), { type: "loading" }));
  active = catalogKey(5);
  snapshot = await poll();
  assert.deepEqual(snapshot.slots.map(slot => slot.threadKey), states.map((_, index) => catalogKey(5 - index)));
  assert.deepEqual(snapshot.slots.map(slot => slot.status), ["working", "error", "awaiting-approval", "awaiting-response", "unread", "idle"]);
  assert.equal(snapshot.slots[0]?.title, `Live ${catalogKey(5)}`);
  assert.equal(snapshot.slots[0]?.activityAt, 42_000);
  assert.equal(snapshot.activeThreadKey, active);

  assert.equal(snapshot.slots[0]?.selected, true);
  rows = [];
  active = catalogKey(91);
  const collapsed = await poll();
  assert.equal(collapsed.activeThreadKey, active);
  assert.deepEqual(collapsed.slots, snapshot.slots.map(slot => ({ ...slot, selected: false })));
  definitions.agentSource.default = "recent";
  assert.deepEqual((await poll()).slots.map(slot => slot.threadKey), nativeSlots.map(slot => slot.threadKey));
  definitions.agentSource.default = "pinned";
  rows = [row(catalogKey(8), { type: "loading" })];
  assert.deepEqual((await poll()).slots.map(slot => slot.threadKey), [catalogKey(8), null, null, null, null, null]);
  active = null;
  composers = composers.slice(0, 1);
  assert.equal((await poll()).activeThreadKey, undefined);
  // Removing the final pin must clear the cached list even with no DOM rows.
  rows = [];
  semanticPinsEmpty = true;
  resources.push({ name: "app://-/assets/app-initial-test.js" });
  snapshot = await poll();
  assert.deepEqual(snapshot.activeCatalog?.candidates, []);
  assert.deepEqual(snapshot.slots.map(slot => slot.status), Array(6).fill("off"));
});
