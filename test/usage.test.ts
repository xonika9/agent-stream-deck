import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { renderRateLimitResetKey, renderUsageLimitKey, renderUsageOverviewKey } from "#stream-deck";
import type { CodexHost, HostHealth, MicroSnapshot, UsageSnapshot, UsageWindow } from "#agents";
import {
  composeMacUsage,
  parseUsageLimitMode,
  parseUsageSettings,
  parseUsageSource,
  selectAccountUsage,
  selectUsageBarWindow,
  selectUsageWindow,
  usageLabel,
  usageTheme,
  usageWindowKind,
} from "#usage";

const fiveHour: UsageWindow = {
  id: "five-hour",
  kind: "five-hour",
  usedPercent: 26,
  remainingPercent: 74,
  windowDurationMins: 300,
  resetsAt: 1_800_000_000_000,
};
const weekly: UsageWindow = {
  id: "weekly",
  kind: "weekly",
  usedPercent: 88,
  remainingPercent: 12,
  windowDurationMins: 10_080,
  resetsAt: 1_800_000_000_000,
};

function usage(windows: UsageWindow[]): UsageSnapshot {
  return { windows, observedAt: Date.now(), resetCreditsAvailable: 2, resetCreditsApplicable: 1 };
}

function decode(dataUrl: string): string {
  return decodeURIComponent(dataUrl.replace(/^data:image\/svg\+xml;charset=utf8,/, ""));
}

test("usage selection prefers 5-hour but falls back to weekly", () => {
  assert.equal(selectUsageWindow(usage([weekly]), "auto"), weekly);
  assert.equal(selectUsageWindow(usage([weekly, fiveHour]), "auto"), fiveHour);
  assert.equal(selectUsageWindow(usage([weekly, fiveHour]), "weekly"), weekly);
  assert.equal(selectUsageWindow(usage([weekly]), "five-hour"), undefined);
  assert.equal(usageWindowKind(300), "five-hour");
  assert.equal(usageWindowKind(10_080), "weekly");
  assert.equal(parseUsageLimitMode("weekly"), "weekly");
  assert.equal(parseUsageLimitMode("unexpected"), "auto");
});

test("usage rendering falls back to light without overriding an available theme", () => {
  const health = { state: "ready", changedAt: 1 } as const;
  assert.equal(usageTheme({ health, usage: usage([weekly]) }), "light");
  assert.equal(usageTheme({ health, usage: usage([weekly]), theme: "dark" }), "dark");
  assert.equal(
    usageTheme({
      health,
      snapshot: {
        slots: [],
        layout: { slots: {} },
        agentSource: "priority",
        lightingAutoOff: false,
        theme: "dark",
      } as unknown as MicroSnapshot,
    }),
    "dark",
  );
});

/** macOS Codex data prefers fresh CodexBar and falls back to the app bridge. */
test("macOS auto prefers CodexBar and keeps bridge reset credits", () => {
  const bridge = usage([fiveHour]);
  const codexBar = usage([weekly]);
  const combined = composeMacUsage(codexBar, bridge);
  assert.deepEqual(combined?.windows, [weekly]);
  assert.equal(combined?.resetCreditsAvailable, 2);

  const appOnly = composeMacUsage(codexBar, bridge, "codex-app");
  assert.deepEqual(appOnly?.windows, [fiveHour]);

  const barOnly = composeMacUsage(undefined, bridge, "codex-bar");
  assert.deepEqual(barOnly?.windows, []);
  assert.equal(barOnly?.resetCreditsAvailable, 2);

  assert.equal(
    composeMacUsage(undefined, {
      ...bridge,
      windows: [],
      resetCreditsAvailable: null,
      resetCreditsApplicable: null,
    }),
    undefined,
  );
});

const macHost: CodexHost = { hostId: "local", hostName: "Mac", platform: "darwin" };
const winHost: CodexHost = { hostId: "local", hostName: "Win", platform: "win32" };
const localReady: HostHealth = { state: "ready", changedAt: 1 };

function localSnapshotWith(usageValue: UsageSnapshot | undefined, platform: "darwin" | "win32" = "darwin") {
  return {
    host: platform === "darwin" ? macHost : winHost,
    snapshot: {
      slots: [],
      layout: { slots: {} },
      agentSource: "priority",
      lightingAutoOff: false,
      theme: "dark",
      usage: usageValue,
    } as unknown as MicroSnapshot,
    observedAt: 1,
  };
}

test("macOS auto falls back from CodexBar to the app bridge", () => {
  const bridge = usage([fiveHour]);
  const source = selectAccountUsage(macHost, localSnapshotWith(bridge), localReady, undefined, "codex-auto");
  assert.deepEqual(source.usage?.windows, [fiveHour]);
  assert.equal(source.health.state, "ready");
});

test("macOS auto without CodexBar or bridge shows empty and unhealthy", () => {
  const offline: HostHealth = { state: "offline", changedAt: 1 };
  const source = selectAccountUsage(macHost, undefined, offline, undefined, "codex-auto");
  assert.deepEqual(source.usage?.windows ?? [], []);
  assert.notEqual(source.health.state, "ready");
});

test("codex-bar source ignores bridge windows", () => {
  const bridge = usage([fiveHour]);
  const source = selectAccountUsage(macHost, localSnapshotWith(bridge), localReady, undefined, "codex-bar");
  assert.deepEqual(source.usage?.windows, []);
});

test("codex-app source ignores CodexBar windows", () => {
  const bridge = usage([fiveHour]);
  const codexBar = usage([weekly]);
  const source = selectAccountUsage(macHost, localSnapshotWith(bridge), localReady, codexBar, "codex-app");
  assert.deepEqual(source.usage?.windows, [fiveHour]);
  assert.equal(source.health.state, "ready");
});

test("windows ignores the saved source and matches the current result", () => {
  const bridge = usage([fiveHour]);
  const snapshot = localSnapshotWith(bridge, "win32");
  const expected = selectAccountUsage(winHost, snapshot, localReady, undefined, "codex-auto");
  assert.deepEqual(expected.usage?.windows, [fiveHour]);
  assert.equal(expected.health.state, "ready");
  for (const source of ["codex-bar", "codex-app", "t3-claude"] as const)
    assert.deepEqual(selectAccountUsage(winHost, snapshot, localReady, undefined, source), expected);
  assert.equal(parseUsageSource("t3-claude", "win32"), "codex-auto");
});

test("usage settings parse with defaults and legacy mode", () => {
  assert.deepEqual(parseUsageSettings({}), {
    source: "codex-auto",
    mode: "auto",
    topWindow: "five-hour",
    bottomWindow: "weekly",
  });
  assert.equal(parseUsageSettings({ mode: "weekly" }).mode, "weekly");
  assert.equal(parseUsageSource("t3-claude", "darwin"), "t3-claude");
  assert.equal(parseUsageSource("bogus", "darwin"), "codex-auto");
  assert.equal(parseUsageSettings({ source: "t3-codex", mode: "weekly-fable" }).mode, "auto");
  assert.equal(parseUsageSettings({ source: "t3-claude", mode: "weekly-fable" }).mode, "weekly-fable");
  assert.equal(parseUsageSettings({ topWindow: "bogus", bottomWindow: "monthly" }).topWindow, "five-hour");
  assert.equal(parseUsageSettings({ topWindow: "bogus", bottomWindow: "monthly" }).bottomWindow, "monthly");
});

test("claude fable window is selected only by its own mode", () => {
  const sevenDay: UsageWindow = {
    id: "seven_day",
    kind: "weekly",
    usedPercent: 10,
    remainingPercent: 90,
    windowDurationMins: 10_080,
    resetsAt: null,
  };
  const fable: UsageWindow = {
    id: "seven_day_fable",
    kind: "weekly-fable",
    usedPercent: 20,
    remainingPercent: 80,
    windowDurationMins: 10_080,
    resetsAt: null,
  };
  const snapshot = usage([sevenDay, fable]);
  assert.equal(selectUsageWindow(snapshot, "weekly"), sevenDay);
  assert.equal(selectUsageWindow(snapshot, "weekly-fable"), fable);
  assert.equal(selectUsageWindow(snapshot, "monthly"), undefined);
  assert.equal(usageLabel("weekly-fable"), "FBL");
  assert.equal(usageLabel("monthly"), "MO");
});

test("overview bars select their own window kind", () => {
  const snapshot = usage([fiveHour, weekly]);
  assert.equal(selectUsageBarWindow(snapshot, "five-hour"), fiveHour);
  assert.equal(selectUsageBarWindow(snapshot, "weekly"), weekly);
  assert.equal(selectUsageBarWindow(snapshot, "monthly"), undefined);
});

test("explicit five-hour mode without that window stays empty", () => {
  assert.equal(selectUsageWindow(usage([weekly]), "five-hour"), undefined);
});

test("renderer refreshes stale account usage without waiting for application focus", async () => {
  const bridge = await readFile(new URL("../src/codex/bridge.ts", import.meta.url), "utf8");
  assert.match(bridge, /Symbol\.for\('codex-deck-rate-limit-refresh-at'\)/);
  assert.match(bridge, /now - dataUpdatedAt >= 15000/);
  assert.match(bridge, /Promise\.resolve\(query\.fetch\(\)\)\.catch/);
  assert.doesNotMatch(bridge, /await query\.fetch\(\)/);
});

test("single usage key preserves the circular design and centers numeric weight", () => {
  const healthy = decode(renderUsageLimitKey(fiveHour, "five-hour", "dark"));
  assert.match(healthy, /data-usage-used="26"/);
  assert.match(healthy, />26<\/text>/);
  assert.match(healthy, /data-usage-percent="vector" transform="translate\(87 57\)"/);
  assert.match(healthy, />5H<\/text>/);
  assert.match(healthy, /data-usage-value="26" x="65" y="80" text-anchor="middle"/);

  const unavailable = decode(renderUsageLimitKey(undefined, "five-hour", "dark"));
  assert.match(unavailable, />—<\/text>/);
  assert.match(unavailable, />5H<\/text>/);
});

test("overview renders the two chosen bar windows in order", () => {
  const svg = decode(renderUsageOverviewKey(fiveHour, "5H", weekly, "WK", "dark"));
  assert.match(svg, /data-usage-window="5H"/);
  assert.match(svg, /data-usage-window="WK"/);
  assert.match(svg, /data-usage-used="26"/);
  assert.match(svg, /data-usage-used="88"/);
  assert.ok(svg.indexOf('data-usage-window="5H"') < svg.indexOf('data-usage-window="WK"'));

  const weeklyOnly = decode(renderUsageOverviewKey(undefined, "5H", weekly, "WK", "dark"));
  assert.match(weeklyOnly, /data-usage-window="5H"[\s\S]*>—<\/text>/);
  assert.match(weeklyOnly, /data-usage-window="WK"[\s\S]*>88%<\/text>/);

  const fable: UsageWindow = {
    id: "seven_day_fable",
    kind: "weekly-fable",
    usedPercent: 70,
    remainingPercent: 30,
    windowDurationMins: 10_080,
    resetsAt: null,
  };
  const claude = decode(renderUsageOverviewKey(fable, "FBL", fiveHour, "5H", "dark"));
  assert.match(claude, /data-usage-window="FBL"[\s\S]*>70%<\/text>/);
  assert.match(claude, /data-usage-window="5H"[\s\S]*>26%<\/text>/);
  assert.ok(claude.indexOf('data-usage-window="FBL"') < claude.indexOf('data-usage-window="5H"'));
});

test("legacy reset counter shows credits without offering a hold action", () => {
  const svg = decode(renderRateLimitResetKey(2, "dark"));
  assert.match(svg, /data-reset-credits="2" x="72" y="78" text-anchor="middle"/);
  assert.doesNotMatch(svg, /data-reset-hold|HOLD/);
  assert.doesNotMatch(svg, /cx="106" cy="40"/);

  const available = decode(renderRateLimitResetKey(1, "dark", "ready"));
  assert.match(available, /data-reset-credits="1"/);
  assert.match(available, /stop-opacity="\.13"/);
});

test("t3 claude ring shows its provider mark while codex and t3 codex do not", () => {
  const claude = decode(renderUsageLimitKey(fiveHour, "five-hour", "dark", "ready", "t3-claude"));
  assert.match(claude, /data-provider-mark="claude"/);
  assert.match(claude, /data-usage-used="26"/);
  assert.match(claude, />5H<\/text>/);

  for (const source of ["codex-auto", "codex-bar", "codex-app", "t3-codex"] as const) {
    const svg = decode(renderUsageLimitKey(fiveHour, "five-hour", "dark", "ready", source));
    assert.doesNotMatch(svg, /data-provider-mark=/, `${source} has no provider mark`);
  }
  const legacy = decode(renderUsageLimitKey(fiveHour, "five-hour", "dark"));
  assert.doesNotMatch(legacy, /data-provider-mark=/);
});

test("t3 overview keeps labels and percentages with its provider mark", () => {
  const marked = decode(renderUsageOverviewKey(fiveHour, "5H", weekly, "WK", "dark", "ready", "t3-opencode"));
  assert.match(marked, /data-provider-mark="opencode"/);
  assert.match(marked, /data-usage-window="5H"[\s\S]*>26%<\/text>/);
  assert.match(marked, /data-usage-window="WK"[\s\S]*>88%<\/text>/);
  assert.match(marked, />5H<\/text>/);
  assert.match(marked, />WK<\/text>/);

  const plain = decode(renderUsageOverviewKey(fiveHour, "5H", weekly, "WK", "dark", "ready", "codex-bar"));
  assert.doesNotMatch(plain, /data-provider-mark=/);
  assert.equal(marked.match(/<text x="(\d+)" y="33"/)?.[1], "35");
  assert.equal(plain.match(/<text x="(\d+)" y="33"/)?.[1], "24");
});

test("provider marks use the theme title colour", () => {
  const light = decode(renderUsageLimitKey(fiveHour, "five-hour", "light", "ready", "t3-claude"));
  assert.match(light, /data-provider-mark="claude"[\s\S]*fill="#171C20"/);
  const dark = decode(renderUsageLimitKey(fiveHour, "five-hour", "dark", "ready", "t3-claude"));
  assert.match(dark, /data-provider-mark="claude"[\s\S]*fill="#F2F2EF"/);
});

test("usage actions and property inspector are packaged without official keycap artwork", async () => {
  const [manifestSource, limitInspector, overviewInspector, bridge] = await Promise.all([
    readFile(new URL("../static/manifest.json", import.meta.url), "utf8"),
    readFile(new URL("../static/property-inspector/usage-limit.html", import.meta.url), "utf8"),
    readFile(new URL("../static/property-inspector/usage-overview.html", import.meta.url), "utf8"),
    readFile(new URL("../src/codex/bridge.ts", import.meta.url), "utf8"),
  ]);
  const manifest = JSON.parse(manifestSource) as {
    Actions: Array<{ UUID: string; Tooltip?: string; PropertyInspectorPath?: string }>;
  };
  const actions = new Map(manifest.Actions.map((action) => [action.UUID, action]));
  assert.equal(
    actions.get("com.xonika9.codex-deck.usage-limit")?.PropertyInspectorPath,
    "static/property-inspector/usage-limit.html",
  );
  assert.equal(
    actions.get("com.xonika9.codex-deck.usage-overview")?.PropertyInspectorPath,
    "static/property-inspector/usage-overview.html",
  );
  for (const uuid of ["com.xonika9.codex-deck.usage-limit", "com.xonika9.codex-deck.usage-overview"] as const) {
    assert.doesNotMatch(actions.get(uuid)?.Tooltip ?? "", /Codex/, `${uuid} tooltip names the provider choice`);
  }
  assert.equal(actions.has("com.xonika9.codex-deck.rate-limit-reset"), true);
  for (const inspector of [limitInspector, overviewInspector]) {
    assert.match(inspector, /"codex-auto"/);
    assert.match(inspector, /"t3-claude"/);
    assert.match(inspector, /"t3-opencode"/);
  }
  assert.match(limitInspector, /"auto"/);
  assert.match(limitInspector, /"weekly-fable"/);
  assert.match(overviewInspector, /"monthly"/);
  assert.doesNotMatch(bridge, /rate-limit-reset-credits\/consume/);
  assert.match(bridge, /applicable_available_count/);
  assert.doesNotMatch(bridge, /profile_image_url/);
});
