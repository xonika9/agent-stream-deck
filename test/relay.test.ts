import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";
import { createServer } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import streamDeck from "@elgato/streamdeck";
import WebSocket from "ws";
import { generate } from "selfsigned";
import { CodexRelayClient, RELAY_SNAPSHOT_STALE_MS, resolveRelayHealth } from "../src/codex-relay-client.js";
import { DeckController } from "../src/controller.js";
import { Agent1 } from "../src/actions.js";
import { isAllowedRelayHost, isPrivateLanHost, privateLanAddresses } from "../src/relay-network.js";
import {
  CodexRelayServer, encodeRelaySnapshotMessage, readRelayServerConfig, relayDiscoveryTxt,
  relaySnapshotFailureShouldDegrade, validateRelayServerConfig
} from "../src/codex-relay-server.js";
import {
  HostActivityIndex, RELAY_PROTOCOL_VERSION, normalizeHostSnapshotAtReceipt,
  parseRelayCommand, parseRelayServerMessage, type HostSnapshot, type RelaySnapshotMessage
} from "../src/relay-protocol.js";
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

test("relay refuses wildcard exposure and short authentication tokens", () => {
  assert.throws(() => validateRelayServerConfig({ enabled: true, listenHost: "0.0.0.0", port: 47_651, token: "x".repeat(32) }), /loopback or a specific Tailscale address/);
  assert.throws(() => validateRelayServerConfig({ enabled: true, listenHost: "203.0.113.10", port: 47_651, token: "x".repeat(32) }), /loopback or a specific Tailscale/);
  assert.throws(() => validateRelayServerConfig({ enabled: true, listenHost: "127.0.0.1", port: 47_651, token: "short" }), /32 bytes/);
  assert.equal(isAllowedRelayHost("100.64.0.42"), true);
  assert.equal(isAllowedRelayHost("example.tailnet.ts.net"), true);
  assert.equal(isAllowedRelayHost("8.8.8.8"), false);
});

test("nearby relay accepts only pinned TLS on a private address and never advertises its token", async () => {
  const certificate = await generate([{ name: "commonName", value: "Codex Deck test" }], {
    keyType: "ec", curve: "P-256", algorithm: "sha256"
  });
  const fingerprint = new X509Certificate(certificate.cert).fingerprint256
    .replaceAll(":", "").toLowerCase();
  const local = {
    enabled: true,
    listenHost: "auto",
    port: 47_653,
    token: "secret".repeat(8),
    transport: "local" as const,
    tls: {
      certificate: certificate.cert,
      privateKey: certificate.private,
      fingerprintSha256: fingerprint
    },
    discovery: { enabled: true }
  };
  validateRelayServerConfig(local);
  const txt = relayDiscoveryTxt(local, host, "192.168.1.25");
  assert.equal(txt.hostId, host.hostId);
  assert.equal(txt.address, "192.168.1.25");
  assert.equal(txt.fingerprint, fingerprint);
  assert.equal(JSON.stringify(txt).includes(local.token), false);
  assert.equal("token" in txt, false);
  assert.throws(
    () => validateRelayServerConfig({ ...local, tls: undefined }), /requires pinned TLS/);
  assert.throws(
    () => validateRelayServerConfig({ ...local, listenHost: "203.0.113.8" }), /secure auto local mode/);
  assert.equal(isPrivateLanHost("10.0.0.4"), true);
  assert.equal(isPrivateLanHost("172.31.9.2"), true);
  assert.equal(isPrivateLanHost("192.168.50.9"), true);
  assert.equal(isPrivateLanHost("100.100.100.100"), false);
  assert.equal(isPrivateLanHost("8.8.8.8"), false);
  assert.deepEqual(privateLanAddresses({
    en0: [
      { address: "192.168.1.25", netmask: "255.255.255.0", family: "IPv4", mac: "aa", internal: false, cidr: "192.168.1.25/24" },
      { address: "fe80::1", netmask: "ffff::", family: "IPv6", mac: "aa", internal: false, cidr: "fe80::1/64", scopeid: 1 }
    ],
    vpn: [{ address: "100.100.100.100", netmask: "255.192.0.0", family: "IPv4", mac: "bb", internal: false, cidr: "100.100.100.100/10" }]
  }), ["192.168.1.25"]);
});

test("optional mobile relay config is absent-safe and validates before startup", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-mobile-relay-"));
  try {
    const path = join(root, "mobile-relay-server.json");
    assert.equal(await readRelayServerConfig(path), null);
    await writeFile(path, JSON.stringify({ enabled: true, listenHost: "127.0.0.1", port: 47_652, token: "m".repeat(32) }));
    assert.deepEqual(await readRelayServerConfig(path), {
      enabled: true, listenHost: "127.0.0.1", port: 47_652, token: "m".repeat(32)
    });
    await writeFile(path, JSON.stringify({ enabled: true, listenHost: "0.0.0.0", port: 47_652, token: "m".repeat(32) }));
    await assert.rejects(readRelayServerConfig(path), /loopback or a specific Tailscale address/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("relay command parser permits only the narrow native command surface", () => {
  const threadKey = "00000000-0000-4000-8000-000000000005";
  assert.deepEqual(parseRelayCommand({ kind: "agent", slot: 5, threadKey, act: 1 }), { kind: "agent", slot: 5, threadKey, act: 1 });
  assert.deepEqual(parseRelayCommand({ kind: "reasoning", direction: "increase" }), { kind: "reasoning", direction: "increase" });
  assert.deepEqual(parseRelayCommand({ kind: "rate-limit-reset" }), { kind: "rate-limit-reset" });
  assert.equal(parseRelayCommand({ kind: "agent", slot: 6, threadKey, act: 1 }), null);
  assert.equal(parseRelayCommand({ kind: "evaluate", expression: "process.exit()" }), null);
  assert.equal(parseRelayCommand({ kind: "keycap", keycapId: "NOT_REAL" }), null);
  assert.notEqual(parseRelayCommand({ kind: "agent", slot: 1, threadKey: "local:019f6de7-44c2-7fe2-9d17-9322c952e626", act: 1 }), null);
  assert.notEqual(parseRelayCommand({ kind: "agent", slot: 0, threadKey: "client-new-thread:e3c18619-71ff-4a8d-8dd3-d475e9bcf162", act: 1 }), null);
  assert.notEqual(parseRelayCommand({ kind: "agent", slot: 0, threadKey: "local:client-new-thread:e3c18619-71ff-4a8d-8dd3-d475e9bcf162", act: 1 }), null);
  assert.equal(parseRelayCommand({ kind: "agent", slot: 1, threadKey: "local:../../secret", act: 1 }), null);
});

test("relay snapshot parser bounds and validates host session catalogs", async () => {
  const valid = { type: "snapshot", protocol: 1, host, observedAt: 1, snapshot: structuredClone(snapshot) };
  valid.snapshot.hostSessions = [{ threadId: "00000000-0000-4000-8000-000000000000", activityAt: 1, status: "working", completionRevision: 42 }];
  valid.snapshot.hostSessions[0]!.contextUsedPercent = 56;
  valid.snapshot.slots[0]!.contextUsedPercent = 56;
  assert.notEqual(parseRelayServerMessage(valid), null);
  valid.snapshot.activeThreadKey = "local:00000000-0000-4000-8000-000000000000";
  valid.snapshot.activeThreadTitle = "Build the iPhone companion";
  assert.notEqual(parseRelayServerMessage(valid), null);
  valid.snapshot.usage = {
    windows: [{ id: "weekly", kind: "weekly", usedPercent: 35, remainingPercent: 65, windowDurationMins: 10_080, resetsAt: 1_800_000_000_000 }],
    observedAt: 1_700_000_000_000,
    resetCreditsAvailable: 1,
    resetCreditsApplicable: 0
  };
  assert.notEqual(parseRelayServerMessage(valid), null);
  const invalidUsage = structuredClone(valid);
  invalidUsage.snapshot.usage!.windows[0]!.remainingPercent = 101;
  assert.equal(parseRelayServerMessage(invalidUsage), null);
  valid.snapshot.activeThreadKey = "local:not-a-thread";
  assert.equal(parseRelayServerMessage(valid), null);
  valid.snapshot.activeThreadKey = "local:00000000-0000-4000-8000-000000000000";
  valid.snapshot.activeThreadTitle = "x".repeat(241);
  assert.equal(parseRelayServerMessage(valid), null);
  delete valid.snapshot.activeThreadTitle;
  delete valid.snapshot.activeThreadKey;
  const invalidRevision = structuredClone(valid);
  invalidRevision.snapshot.hostSessions![0]!.completionRevision = -1;
  assert.equal(parseRelayServerMessage(invalidRevision), null);
  const invalidContext = structuredClone(valid);
  invalidContext.snapshot.slots[0]!.contextUsedPercent = 101;
  assert.equal(parseRelayServerMessage(invalidContext), null);
  const invalid = structuredClone(valid) as typeof valid & { snapshot: { hostSessions: unknown[] } };
  invalid.snapshot.hostSessions = Array.from({ length: 129 }, () => valid.snapshot.hostSessions![0]!);
  assert.equal(parseRelayServerMessage(invalid), null);
  assert.notEqual(parseRelayServerMessage({
    type: "health", protocol: 1, host, state: "degraded",
    reason: "native-signals-unavailable", observedAt: 2
  }), null);
  assert.equal(parseRelayServerMessage({
    type: "health", protocol: 1, host, state: "offline",
    reason: "native-signals-unavailable", observedAt: 2
  }), null);
});

test("relay v1 keeps only valid atomic work-start pairs without rejecting the snapshot", () => {
  const base = { type: "snapshot", protocol: 1, host, observedAt: 2_000, snapshot: structuredClone(snapshot) };
  base.snapshot.hostSessions = [{
    threadId: "00000000-0000-4000-8000-000000000000", activityAt: 1_900,
    status: "working", workStartedAt: 1_800, workStartRevision: 42
  }];
  const parsedBase = parseRelayServerMessage(base);
  assert.deepEqual(parsedBase?.type === "snapshot" ? parsedBase.snapshot.hostSessions?.[0] : null,
    base.snapshot.hostSessions[0]);

  for (const invalidPair of [
    { workStartedAt: undefined, workStartRevision: 42 },
    { workStartedAt: 1_800, workStartRevision: undefined },
    { workStartedAt: -1, workStartRevision: 42 },
    { workStartedAt: Number.POSITIVE_INFINITY, workStartRevision: 42 },
    { workStartedAt: 2_001, workStartRevision: 42 },
    { workStartedAt: 1_800, workStartRevision: -1 },
    { workStartedAt: 1_800, workStartRevision: 1.5 },
    { workStartedAt: 1_800, workStartRevision: Number.MAX_SAFE_INTEGER + 1 }
  ]) {
    const value = structuredClone(base);
    Object.assign(value.snapshot.hostSessions![0]!, invalidPair);
    const parsed = parseRelayServerMessage(value);
    assert.equal(parsed?.type, "snapshot");
    if (parsed?.type === "snapshot") {
      assert.equal(parsed.snapshot.hostSessions?.[0]?.workStartedAt, undefined);
      assert.equal(parsed.snapshot.hostSessions?.[0]?.workStartRevision, undefined);
    }
  }

  const oldSender = structuredClone(base);
  delete oldSender.snapshot.hostSessions![0]!.workStartedAt;
  delete oldSender.snapshot.hostSessions![0]!.workStartRevision;
  assert.equal(parseRelayServerMessage(oldSender)?.type, "snapshot");

  const invalidAnnotations = structuredClone(base);
  Object.assign(invalidAnnotations.snapshot.slots[0]!, { workStartedAt: 1_700 });
  invalidAnnotations.snapshot.activeCatalog = { complete: true, candidates: [{
    threadKey: "local:00000000-0000-4000-8000-000000000090",
    conversationId: "00000000-0000-4000-8000-000000000090",
    title: "Off six", status: "working", selected: false, catalogIndex: 7,
    workStartedAt: 2_001, workStartRevision: 8
  }] };
  const sanitizedAnnotations = parseRelayServerMessage(invalidAnnotations);
  assert.equal(sanitizedAnnotations?.type, "snapshot");
  if (sanitizedAnnotations?.type === "snapshot") {
    assert.equal(sanitizedAnnotations.snapshot.slots[0]!.workStartedAt, undefined);
    assert.equal(sanitizedAnnotations.snapshot.slots[0]!.workStartRevision, undefined);
    assert.equal(sanitizedAnnotations.snapshot.activeCatalog?.candidates[0]?.workStartedAt, undefined);
    assert.equal(sanitizedAnnotations.snapshot.activeCatalog?.candidates[0]?.workStartRevision, undefined);
  }
});

test("relay validates and sanitizes the optional active catalog without disabling the base snapshot", () => {
  const valid = { type: "snapshot", protocol: 1, host, observedAt: 1, snapshot: structuredClone(snapshot) };
  valid.snapshot.activeCatalog = { complete: true, candidates: [{
    threadKey: "local:00000000-0000-4000-8000-000000000090",
    conversationId: "00000000-0000-4000-8000-000000000090",
    title: "Off six", status: "working", selected: false, activityAt: 90,
    catalogIndex: 7, nativeSlot: 5, ownedByHost: true, contextUsedPercent: 42
  }] };
  Object.assign(valid.snapshot.activeCatalog, { prompt: "catalog secret", extra: true });
  Object.assign(valid.snapshot.activeCatalog.candidates[0]!, {
    prompt: "candidate secret", response: "private output", extra: { nested: true }
  });
  const parsed = parseRelayServerMessage(valid);
  assert.equal(parsed?.type, "snapshot");
  if (parsed?.type !== "snapshot") return;
  assert.equal(parsed.snapshot.activeCatalog?.candidates.length, 1);
  assert.deepEqual(parsed.snapshot.activeCatalog, { complete: true, candidates: [{
    threadKey: "local:00000000-0000-4000-8000-000000000090",
    conversationId: "00000000-0000-4000-8000-000000000090",
    title: "Off six", status: "working", selected: false, activityAt: 90,
    catalogIndex: 7, nativeSlot: 5, ownedByHost: true, contextUsedPercent: 42
  }] });

  const malformed = structuredClone(valid);
  malformed.snapshot.activeCatalog!.candidates[0]!.threadKey = "../../secret";
  const sanitized = parseRelayServerMessage(malformed);
  assert.equal(sanitized?.type, "snapshot");
  if (sanitized?.type === "snapshot") {
    assert.equal(sanitized.snapshot.activeCatalog, undefined);
    assert.deepEqual(sanitized.snapshot.slots, snapshot.slots);
  }

  const oversized = structuredClone(valid);
  oversized.snapshot.activeCatalog!.candidates = Array.from(
    { length: 257 }, (_, catalogIndex) => ({
      ...valid.snapshot.activeCatalog!.candidates[0]!, catalogIndex,
      threadKey: `local:00000000-0000-4000-8000-${catalogIndex.toString().padStart(12, "0")}`
    })
  );
  const fallback = parseRelayServerMessage(oversized);
  assert.equal(fallback?.type, "snapshot");
  if (fallback?.type === "snapshot") {
    assert.equal(fallback.snapshot.activeCatalog, undefined);
    assert.deepEqual(fallback.snapshot.slots, snapshot.slots);
  }
});

test("relay health becomes degraded from local receipt age without trusting remote clocks", () => {
  const ready = { state: "ready", changedAt: 900 } as const;
  assert.equal(resolveRelayHealth(ready, true, 1_000, 1_000 + RELAY_SNAPSHOT_STALE_MS).state, "ready");
  assert.deepEqual(resolveRelayHealth(ready, true, 1_000, 1_001 + RELAY_SNAPSHOT_STALE_MS), {
    state: "degraded", reason: "snapshot-stale", changedAt: 1_000
  });
  const offline = { state: "offline", reason: "relay-disconnected", changedAt: 2_000 } as const;
  assert.equal(resolveRelayHealth(offline, true, 1_000, 99_000), offline);
});

test("remote snapshots are normalized to the receiver clock", () => {
  const remote = structuredClone(snapshot);
  remote.hostSessions = [{
    threadId: remote.slots[0]!.threadKey!, activityAt: 970_000,
    status: "working", completionRevision: undefined,
    workStartedAt: 960_000, workStartRevision: 123
  }];
  remote.usage = {
    windows: [{
      id: "weekly", kind: "weekly", usedPercent: 40, remainingPercent: 60,
      windowDurationMins: 10_080, resetsAt: 1_600_000
    }],
    observedAt: 1_000_000,
    resetCreditsAvailable: 1,
    resetCreditsApplicable: 1
  };
  remote.slots[0]!.activityAt = 990_000;
  remote.activeCatalog = { complete: true, candidates: [{
    threadKey: remote.slots[0]!.threadKey!, title: "Catalog task", status: "working",
    selected: false, activityAt: 980_000, catalogIndex: 0
  }] };

  const normalized = normalizeHostSnapshotAtReceipt(
    { host, snapshot: remote, observedAt: 1_000_000 }, 1_030_000);
  assert.equal(normalized.observedAt, 1_030_000);
  assert.equal(normalized.snapshot.slots[0]!.activityAt, 1_020_000);
  assert.equal(normalized.snapshot.hostSessions![0]!.activityAt, 1_000_000);
  assert.equal(normalized.snapshot.hostSessions![0]!.workStartedAt, 990_000);
  assert.equal(normalized.snapshot.hostSessions![0]!.workStartRevision, 123);
  assert.equal(normalized.snapshot.activeCatalog!.candidates[0]!.activityAt, 1_010_000);
  assert.equal(normalized.snapshot.usage!.observedAt, 1_030_000);
  assert.equal(normalized.snapshot.usage!.windows[0]!.resetsAt, 1_630_000);
});

test("work-start normalization uses positive and negative clock offsets without changing revision", () => {
  const remote = structuredClone(snapshot);
  remote.hostSessions = [{
    threadId: remote.slots[0]!.threadKey!, activityAt: 1_900, status: "working",
    workStartedAt: 1_800, workStartRevision: 9
  }];
  const ahead = normalizeHostSnapshotAtReceipt({ host, snapshot: remote, observedAt: 2_000 }, 2_500);
  assert.deepEqual(
    [ahead.snapshot.hostSessions![0]!.workStartedAt, ahead.snapshot.hostSessions![0]!.workStartRevision],
    [2_300, 9]
  );
  const behind = normalizeHostSnapshotAtReceipt({ host, snapshot: remote, observedAt: 2_000 }, 1_500);
  assert.deepEqual(
    [behind.snapshot.hostSessions![0]!.workStartedAt, behind.snapshot.hostSessions![0]!.workStartRevision],
    [1_300, 9]
  );
});

test("clock skew cannot hide a remote owner status or selection", () => {
  const windows: CodexHost = {
    hostId: "11111111-1111-4111-8111-111111111111", hostName: "Windows", platform: "win32"
  };
  const threadKey = snapshot.slots[0]!.threadKey!;
  const macMirror = structuredClone(snapshot);
  const windowsOwner = structuredClone(snapshot);
  macMirror.slots[0]!.status = "idle";
  macMirror.slots[0]!.selected = false;
  macMirror.slots[0]!.ownedByHost = false;
  windowsOwner.slots[0]!.status = "working";
  windowsOwner.slots[0]!.selected = true;
  windowsOwner.slots[0]!.ownedByHost = true;
  windowsOwner.hostSessions = [{
    threadId: threadKey, activityAt: 995_000, status: "working", completionRevision: undefined
  }];
  const normalizedRemote = normalizeHostSnapshotAtReceipt(
    { host: windows, snapshot: windowsOwner, observedAt: 1_000_000 }, 1_030_000);
  const merged = new HostActivityIndex().merge([
    { host, snapshot: macMirror, observedAt: 1_030_000 }, normalizedRemote
  ]);
  const task = merged.find((slot) => slot.threadKey === threadKey)!;
  assert.equal(task.status, "working");
  assert.equal(task.selected, true);
  assert.equal(task.host.hostId, windows.hostId);
});

test("relay suppresses one transient renderer failure after a healthy snapshot", () => {
  assert.equal(relaySnapshotFailureShouldDegrade(false, 1), true, "initial failure has no safe snapshot");
  assert.equal(relaySnapshotFailureShouldDegrade(true, 1), false, "one transient failure keeps last-known state");
  assert.equal(relaySnapshotFailureShouldDegrade(true, 2), true, "repeated failures surface degraded health");
});

test("host activity merge globally orders explicit Mac and Windows timestamps", () => {
  const windows: CodexHost = { hostId: "11111111-1111-4111-8111-111111111111", hostName: "Windows", platform: "win32" };
  const macSnapshot = structuredClone(snapshot);
  const windowsSnapshot = structuredClone(snapshot);
  for (const slot of windowsSnapshot.slots) slot.threadKey = `10000000-0000-4000-8000-00000000000${slot.id}`;
  for (const slot of [...macSnapshot.slots, ...windowsSnapshot.slots]) slot.activityAt = 1;
  macSnapshot.slots[0]!.activityAt = 100;
  windowsSnapshot.slots[0]!.activityAt = 200;
  const merged = new HostActivityIndex().merge([
    { host, snapshot: macSnapshot, observedAt: 1_000 },
    { host: windows, snapshot: windowsSnapshot, observedAt: 1_000 }
  ]);
  assert.equal(merged[0]!.host.platform, "win32");
  assert.equal(merged[0]!.sourceSlot, 0);
  assert.ok(merged.some((slot) => slot.host.platform === "darwin"));
});

test("a newly connected host cannot make unknown historical activity look recent", () => {
  const windows: CodexHost = { hostId: "11111111-1111-4111-8111-111111111111", hostName: "Windows", platform: "win32" };
  const macSnapshot = structuredClone(snapshot);
  const windowsSnapshot = structuredClone(snapshot);
  for (const slot of [...macSnapshot.slots, ...windowsSnapshot.slots]) {
    delete slot.activityAt;
    slot.status = "idle";
    slot.selected = false;
  }
  windowsSnapshot.slots[0]!.selected = true;
  windowsSnapshot.slots[0]!.status = "working";
  const merged = new HostActivityIndex().merge([
    { host: windows, snapshot: windowsSnapshot, observedAt: 1_000 },
    { host, snapshot: macSnapshot, observedAt: 9_000 }
  ]);
  assert.equal(merged[0]!.host.platform, "win32");
  assert.equal(merged[0]!.threadKey, windowsSnapshot.slots[0]!.threadKey);
  assert.equal(merged[0]!.activityAt, 0);
});

test("an idle cloud thread visible on both hosts keeps the first stable owner", () => {
  const windows: CodexHost = { hostId: "11111111-1111-4111-8111-111111111111", hostName: "Windows", platform: "win32" };
  const shared = "00000000-0000-4000-8000-000000000000";
  const macSnapshot = structuredClone(snapshot);
  const windowsSnapshot = structuredClone(snapshot);
  for (const candidate of [macSnapshot.slots[5]!, windowsSnapshot.slots[5]!]) {
    candidate.threadKey = shared;
    candidate.status = "idle";
    candidate.selected = false;
    delete candidate.activityAt;
  }
  const match = new HostActivityIndex().merge([
    { host: windows, snapshot: windowsSnapshot, observedAt: 1_000 },
    { host, snapshot: macSnapshot, observedAt: 9_000 }
  ]).find((slot) => slot.threadKey === shared);
  assert.equal(match?.host.platform, "win32");
});

test("backing rollout ownership beats a mirrored remote-SSH recent entry", () => {
  const windows: CodexHost = { hostId: "11111111-1111-4111-8111-111111111111", hostName: "Windows", platform: "win32" };
  const shared = "00000000-0000-4000-8000-000000000000";
  const macSnapshot = structuredClone(snapshot);
  const windowsSnapshot = structuredClone(snapshot);
  macSnapshot.slots[0] = { ...macSnapshot.slots[0]!, threadKey: shared, status: "idle", selected: false, ownedByHost: true };
  windowsSnapshot.slots[0] = { ...windowsSnapshot.slots[0]!, threadKey: shared, status: "working", selected: true, ownedByHost: false };
  const match = new HostActivityIndex().merge([
    { host: windows, snapshot: windowsSnapshot, observedAt: 2_000 },
    { host, snapshot: macSnapshot, observedAt: 1_000 }
  ]).find((slot) => slot.threadKey === shared);
  assert.equal(match?.host.platform, "darwin", "commands route to the host with the rollout");
  assert.equal(match?.status, "working", "the strongest mirrored live status remains visible");
  assert.equal(match?.selected, true, "selection is aggregated across both visible mirrors");
});

test("a stale mirrored working state cannot override a fresh idle owner", () => {
  const windows: CodexHost = { hostId: "11111111-1111-4111-8111-111111111111", hostName: "Windows", platform: "win32" };
  const shared = "00000000-0000-4000-8000-000000000000";
  const macSnapshot = structuredClone(snapshot);
  const windowsSnapshot = structuredClone(snapshot);
  macSnapshot.slots[0] = {
    ...macSnapshot.slots[0]!, threadKey: shared, status: "idle", selected: false, ownedByHost: true
  };
  windowsSnapshot.slots[0] = {
    ...windowsSnapshot.slots[0]!, threadKey: shared, status: "working", selected: true, ownedByHost: false
  };
  const match = new HostActivityIndex().merge([
    { host: windows, snapshot: windowsSnapshot, observedAt: 1_000 },
    { host, snapshot: macSnapshot, observedAt: 7_001 }
  ]).find((slot) => slot.threadKey === shared);
  assert.equal(match?.host.platform, "darwin", "the backing host still receives commands");
  assert.equal(match?.status, "idle", "fresh native state wins over a stale mirror");
  assert.equal(match?.selected, false, "stale remote selection is not aggregated");
});

test("a recent mirrored working state still augments a fresh idle owner", () => {
  const windows: CodexHost = { hostId: "11111111-1111-4111-8111-111111111111", hostName: "Windows", platform: "win32" };
  const shared = "00000000-0000-4000-8000-000000000000";
  const macSnapshot = structuredClone(snapshot);
  const windowsSnapshot = structuredClone(snapshot);
  macSnapshot.slots[0] = {
    ...macSnapshot.slots[0]!, threadKey: shared, status: "idle", selected: false, ownedByHost: true
  };
  windowsSnapshot.slots[0] = {
    ...windowsSnapshot.slots[0]!, threadKey: shared, status: "working", selected: true, ownedByHost: false
  };
  const match = new HostActivityIndex().merge([
    { host: windows, snapshot: windowsSnapshot, observedAt: 3_000 },
    { host, snapshot: macSnapshot, observedAt: 7_001 }
  ]).find((slot) => slot.threadKey === shared);
  assert.equal(match?.status, "working");
  assert.equal(match?.selected, true);
});

test("host session catalogs route a mirror even when the owning host has no native slot for it", () => {
  const windows: CodexHost = { hostId: "11111111-1111-4111-8111-111111111111", hostName: "Windows", platform: "win32" };
  const shared = "00000000-0000-4000-8000-000000000000";
  const macSnapshot = structuredClone(snapshot);
  const windowsSnapshot = structuredClone(snapshot);
  macSnapshot.slots[0] = { ...macSnapshot.slots[0]!, threadKey: "40000000-0000-4000-8000-000000000099", status: "idle" };
  windowsSnapshot.slots[0] = { ...windowsSnapshot.slots[0]!, threadKey: shared, title: "Mac-owned task", status: "idle", ownedByHost: false };
  macSnapshot.hostSessions = [{
    threadId: shared, activityAt: 2_000, status: "working",
    workStartedAt: 1_800, workStartRevision: 7
  }];
  Object.assign(windowsSnapshot.slots[0]!, { workStartedAt: 1_999, workStartRevision: 99 });
  const match = new HostActivityIndex().merge([
    { host: windows, snapshot: windowsSnapshot, observedAt: 2_000 },
    { host, snapshot: macSnapshot, observedAt: 2_000 }
  ], 2_000, windows.hostId).find((slot) => slot.threadKey === shared);
  assert.equal(match?.host.platform, "darwin");
  assert.equal(match?.status, "working");
  assert.equal(match?.title, "Mac-owned task");
  assert.equal(match?.workStartedAt, 1_800);
  assert.equal(match?.workStartRevision, 7);
});

test("host session catalogs return a Mac-only cloud mirror to its Windows owner", () => {
  const windows: CodexHost = { hostId: "11111111-1111-4111-8111-111111111111", hostName: "Windows", platform: "win32" };
  const shared = "00000000-0000-4000-8000-000000000000";
  const macSnapshot = structuredClone(snapshot);
  const windowsSnapshot = structuredClone(snapshot);
  macSnapshot.slots[0] = { ...macSnapshot.slots[0]!, threadKey: shared, status: "working", ownedByHost: false };
  windowsSnapshot.slots[0] = { ...windowsSnapshot.slots[0]!, threadKey: "40000000-0000-4000-8000-000000000099", status: "idle" };
  windowsSnapshot.hostSessions = [{ threadId: shared, activityAt: 2_000, status: "idle" }];
  const match = new HostActivityIndex().merge([
    { host: windows, snapshot: windowsSnapshot, observedAt: 2_000 },
    { host, snapshot: macSnapshot, observedAt: 2_000 }
  ], 2_000, windows.hostId).find((slot) => slot.threadKey === shared);
  assert.equal(match?.host.platform, "win32");
  assert.equal(match?.status, "working");
});

test("tracked off-six owner annotations keep work-start metadata without lending it to aliases", () => {
  const windows: CodexHost = {
    hostId: "11111111-1111-4111-8111-111111111111", hostName: "Windows", platform: "win32"
  };
  const shared = "00000000-0000-4000-8000-000000000091";
  const windowsSnapshot = structuredClone(snapshot);
  const macSnapshot = structuredClone(snapshot);
  windowsSnapshot.activeCatalog = { complete: true, candidates: [{
    threadKey: `remote:${shared}`, conversationId: shared, title: "Mirror", status: "working",
    selected: false, catalogIndex: 7, ownedByHost: false,
    workStartedAt: 1_999, workStartRevision: 99
  }] };
  macSnapshot.activeCatalog = { complete: true, candidates: [{
    threadKey: `local:${shared}`, conversationId: shared, title: null, status: "working",
    selected: false, catalogIndex: 129, ownedByHost: true,
    workStartedAt: 1_800, workStartRevision: 7
  }] };
  const match = new HostActivityIndex().mergeActiveCatalog([
    { host: windows, snapshot: windowsSnapshot, observedAt: 2_000 },
    { host, snapshot: macSnapshot, observedAt: 2_000 }
  ], 2_000, windows.hostId).find((slot) => slot.conversationId === shared);
  assert.equal(match?.workStartedAt, 1_800);
  assert.equal(match?.workStartRevision, 7);

  macSnapshot.activeCatalog!.candidates[0]!.threadKey = `local:client-new-thread:${shared}`;
  delete macSnapshot.activeCatalog!.candidates[0]!.conversationId;
  const temporary = new HostActivityIndex().mergeActiveCatalog([
    { host: windows, snapshot: windowsSnapshot, observedAt: 2_000 },
    { host, snapshot: macSnapshot, observedAt: 2_000 }
  ], 2_000, windows.hostId).find((slot) => slot.threadKey?.includes("client-new-thread"));
  assert.equal(temporary?.workStartedAt, undefined);
  assert.equal(temporary?.workStartRevision, undefined);
});

test("temporary Windows new-thread keys merge with a titleless session-backed Mac mirror", () => {
  const windows: CodexHost = {
    hostId: "11111111-1111-4111-8111-111111111111", hostName: "Windows", platform: "win32"
  };
  const temporary = "local:client-new-thread:819699e8-ed6d-46fb-bfd1-3280c028de2b";
  const rollout = "019f804a-4e0a-7b32-bf66-af64a405d2d5";
  const title = "Autocheck 3 Installation prüfen";
  const windowsSnapshot = structuredClone(snapshot);
  const macSnapshot = structuredClone(snapshot);
  windowsSnapshot.agentSource = "priority";
  macSnapshot.agentSource = "priority";
  windowsSnapshot.activeThreadKey = rollout;
  windowsSnapshot.slots[0] = {
    ...windowsSnapshot.slots[0]!, threadKey: temporary, title, status: "idle",
    selected: true, ownedByHost: false
  };
  windowsSnapshot.hostSessions = [
    { threadId: rollout, activityAt: 2_000, status: "working", contextUsedPercent: 59 }
  ];
  macSnapshot.slots[0] = {
    ...macSnapshot.slots[0]!, threadKey: `local:${rollout}`, title: null, status: "working",
    selected: false, ownedByHost: false
  };

  const index = new HostActivityIndex();
  const merged = index.merge([
    { host: windows, snapshot: windowsSnapshot, observedAt: 2_000 },
    { host, snapshot: macSnapshot, observedAt: 2_000 }
  ], 2_000, windows.hostId);
  const matches = merged.filter((slot) => slot.title === title);

  assert.equal(matches.length, 1);
  assert.equal(matches[0]!.host.platform, "win32");
  assert.equal(matches[0]!.sourceSlot, 0);
  assert.equal(matches[0]!.threadKey, temporary, "commands keep the live Windows slot key");
  assert.equal(matches[0]!.selected, true);
  assert.equal(matches[0]!.status, "working", "the live mirror status remains visible");
  assert.equal(matches[0]!.contextUsedPercent, 59);

  windowsSnapshot.slots[0]!.selected = false;
  windowsSnapshot.activeThreadKey = "10000000-0000-4000-8000-000000000000";
  const afterSelectionMoves = index.merge([
    { host: windows, snapshot: windowsSnapshot, observedAt: 3_000 },
    { host, snapshot: macSnapshot, observedAt: 3_000 }
  ], 3_000, windows.hostId).filter((slot) => slot.threadKey?.endsWith(rollout) || slot.threadKey === temporary);
  assert.equal(afterSelectionMoves.length, 1, "the learned alias survives a later selection change");
  assert.equal(afterSelectionMoves[0]!.title, title);
});

test("a titled mirror supplies the label when the rollout owner is titleless", () => {
  const windows: CodexHost = {
    hostId: "11111111-1111-4111-8111-111111111111", hostName: "Windows", platform: "win32"
  };
  const shared = "11000000-0000-4000-8000-000000000000";
  const windowsSnapshot = structuredClone(snapshot);
  const macSnapshot = structuredClone(snapshot);
  windowsSnapshot.slots[0] = {
    ...windowsSnapshot.slots[0]!, threadKey: shared, title: "Visible on Windows", ownedByHost: false
  };
  macSnapshot.slots[0] = {
    ...macSnapshot.slots[0]!, threadKey: `local:${shared}`, title: null, ownedByHost: true
  };
  macSnapshot.hostSessions = [{ threadId: shared, activityAt: 2_000, status: "idle" }];

  const merged = new HostActivityIndex().merge([
    { host: windows, snapshot: windowsSnapshot, observedAt: 2_000 },
    { host, snapshot: macSnapshot, observedAt: 2_000 }
  ], 2_000, windows.hostId);
  const matches = merged.filter((slot) => slot.threadKey?.endsWith(shared));
  assert.equal(matches.length, 1);
  assert.equal(matches[0]!.host.platform, "darwin");
  assert.equal(matches[0]!.title, "Visible on Windows");
});

test("a learned Mac new-thread alias survives a Windows relay reconnect", () => {
  const windows: CodexHost = {
    hostId: "11111111-1111-4111-8111-111111111111", hostName: "Windows", platform: "win32"
  };
  const temporary = "local:client-new-thread:12000000-0000-4000-8000-000000000000";
  const rollout = "13000000-0000-4000-8000-000000000000";
  const title = "New Mac task";
  const windowsSnapshot = structuredClone(snapshot);
  const macSnapshot = structuredClone(snapshot);
  windowsSnapshot.agentSource = "priority";
  macSnapshot.agentSource = "priority";
  windowsSnapshot.slots[0] = {
    ...windowsSnapshot.slots[0]!, threadKey: rollout, title: null, status: "working",
    selected: false, ownedByHost: false
  };
  macSnapshot.activeThreadKey = rollout;
  macSnapshot.slots[0] = {
    ...macSnapshot.slots[0]!, threadKey: temporary, title, status: "working",
    selected: true, ownedByHost: false
  };
  macSnapshot.hostSessions = [
    { threadId: rollout, activityAt: 2_000, status: "working", contextUsedPercent: 12 }
  ];
  const index = new HostActivityIndex();
  const inputs = () => [
    { host: windows, snapshot: windowsSnapshot, observedAt: 2_000 },
    { host, snapshot: macSnapshot, observedAt: 2_000 }
  ];

  assert.equal(index.merge(inputs(), 2_000, windows.hostId)
    .filter((slot) => slot.threadKey?.endsWith(rollout) || slot.threadKey === temporary).length, 1);
  index.merge([{ host: windows, snapshot: windowsSnapshot, observedAt: 2_500 }], 2_500, windows.hostId);
  macSnapshot.slots[0]!.selected = false;
  macSnapshot.activeThreadKey = "14000000-0000-4000-8000-000000000000";
  const reconnected = index.merge(inputs().map((input) => ({ ...input, observedAt: 3_000 })), 3_000, windows.hostId)
    .filter((slot) => slot.threadKey?.endsWith(rollout) || slot.threadKey === temporary);
  assert.equal(reconnected.length, 1);
  assert.equal(reconnected[0]!.host.platform, "darwin");
  assert.equal(reconnected[0]!.title, title);
  assert.equal(reconnected[0]!.contextUsedPercent, 12);
});

test("delayed mirror status does not reorder an owned active task", () => {
  const windows: CodexHost = { hostId: "11111111-1111-4111-8111-111111111111", hostName: "Windows", platform: "win32" };
  const shared = "00000000-0000-4000-8000-000000000000";
  const macSnapshot = structuredClone(snapshot);
  const windowsSnapshot = structuredClone(snapshot);
  for (const slot of [...macSnapshot.slots, ...windowsSnapshot.slots]) {
    slot.status = "idle";
    slot.selected = false;
    delete slot.activityAt;
  }
  macSnapshot.slots[0] = { ...macSnapshot.slots[0]!, threadKey: shared, ownedByHost: true };
  windowsSnapshot.slots[0] = { ...windowsSnapshot.slots[0]!, threadKey: shared, ownedByHost: false };
  const index = new HostActivityIndex();
  index.merge([
    { host, snapshot: macSnapshot, observedAt: 500 },
    { host: windows, snapshot: windowsSnapshot, observedAt: 500 }
  ]);

  macSnapshot.slots[0]!.status = "working";
  macSnapshot.slots[0]!.selected = true;
  let match = index.merge([
    { host, snapshot: macSnapshot, observedAt: 1_000 },
    { host: windows, snapshot: windowsSnapshot, observedAt: 1_000 }
  ]).find((slot) => slot.threadKey === shared);
  assert.equal(match?.activityAt, 1_000);

  windowsSnapshot.slots[0]!.status = "working";
  windowsSnapshot.slots[0]!.selected = true;
  match = index.merge([
    { host, snapshot: macSnapshot, observedAt: 2_000 },
    { host: windows, snapshot: windowsSnapshot, observedAt: 2_000 }
  ]).find((slot) => slot.threadKey === shared);
  assert.equal(match?.activityAt, 1_000, "the delayed non-owner mirror cannot refresh recency");
});

test("the same cloud thread is shown once and owned by its live active host", () => {
  const windows: CodexHost = { hostId: "11111111-1111-4111-8111-111111111111", hostName: "Windows", platform: "win32" };
  const macSnapshot = structuredClone(snapshot);
  const windowsSnapshot = structuredClone(snapshot);
  const shared = "00000000-0000-4000-8000-000000000000";
  macSnapshot.slots[0] = { ...macSnapshot.slots[0]!, threadKey: shared, status: "working", activityAt: 100 };
  windowsSnapshot.slots[0] = { ...windowsSnapshot.slots[0]!, threadKey: shared, status: "idle", activityAt: 200 };
  const index = new HostActivityIndex();
  const merged = index.merge([
    { host, snapshot: macSnapshot, observedAt: 1_000 },
    { host: windows, snapshot: windowsSnapshot, observedAt: 1_000 }
  ]);
  const matches = merged.filter((slot) => slot.threadKey === shared);
  assert.equal(matches.length, 1);
  assert.equal(matches[0]!.host.platform, "darwin");
  assert.equal(matches[0]!.status, "working");

  macSnapshot.slots[0] = { ...macSnapshot.slots[0]!, status: "idle" };
  const afterCompletion = index.merge([
    { host, snapshot: macSnapshot, observedAt: 2_000 },
    { host: windows, snapshot: windowsSnapshot, observedAt: 2_000 }
  ]).find((slot) => slot.threadKey === shared);
  assert.equal(afterCompletion?.host.platform, "darwin", "the host that completed the task retains ownership");
});

test("single-host agent modes preserve Codex's native six-slot order", () => {
  const pinned = structuredClone(snapshot);
  pinned.agentSource = "pinned";
  for (const slot of pinned.slots) {
    slot.status = "idle";
    slot.selected = false;
    slot.activityAt = slot.id;
  }
  const merged = new HostActivityIndex().merge([{ host, snapshot: pinned, observedAt: 1_000 }], 1_000, host.hostId);
  assert.deepEqual(merged.map((slot) => slot.threadKey), pinned.slots.map((slot) => slot.threadKey));
  assert.deepEqual(merged.map((slot) => slot.id), [0, 1, 2, 3, 4, 5]);
});

test("combined pinned mode interleaves both hosts and routes mirrored tasks to the owner", () => {
  const windows: CodexHost = { hostId: "11111111-1111-4111-8111-111111111111", hostName: "Windows", platform: "win32" };
  const shared = "20000000-0000-4000-8000-000000000000";
  const windowsSnapshot = structuredClone(snapshot);
  const macSnapshot = structuredClone(snapshot);
  windowsSnapshot.agentSource = "pinned";
  macSnapshot.agentSource = "pinned";
  for (const slot of windowsSnapshot.slots) slot.threadKey = `21000000-0000-4000-8000-00000000000${slot.id}`;
  for (const slot of macSnapshot.slots) slot.threadKey = `22000000-0000-4000-8000-00000000000${slot.id}`;
  windowsSnapshot.slots[0] = { ...windowsSnapshot.slots[0]!, threadKey: shared, ownedByHost: false };
  macSnapshot.slots[4] = { ...macSnapshot.slots[4]!, threadKey: shared, ownedByHost: true };
  const merged = new HostActivityIndex().merge([
    { host: windows, snapshot: windowsSnapshot, observedAt: 1_000 },
    { host, snapshot: macSnapshot, observedAt: 1_000 }
  ], 1_000, windows.hostId);
  assert.equal(merged[0]!.threadKey, shared);
  assert.equal(merged[0]!.host.platform, "darwin");
  assert.equal(merged[0]!.sourceSlot, 4);
  assert.deepEqual(merged.slice(1).map((slot) => slot.threadKey), [
    macSnapshot.slots[0]!.threadKey,
    windowsSnapshot.slots[1]!.threadKey,
    macSnapshot.slots[1]!.threadKey,
    windowsSnapshot.slots[2]!.threadKey,
    macSnapshot.slots[2]!.threadKey
  ]);
});

test("combined custom mode uses the remote assignment when the controller slot is empty", () => {
  const windows: CodexHost = { hostId: "11111111-1111-4111-8111-111111111111", hostName: "Windows", platform: "win32" };
  const windowsSnapshot = structuredClone(snapshot);
  const macSnapshot = structuredClone(snapshot);
  windowsSnapshot.agentSource = "custom";
  macSnapshot.agentSource = "custom";
  windowsSnapshot.slots[0] = { id: 0, threadKey: null, title: null, status: "off", selected: false };
  macSnapshot.slots[0] = { ...macSnapshot.slots[0]!, threadKey: "30000000-0000-4000-8000-000000000000", ownedByHost: true };
  const merged = new HostActivityIndex().merge([
    { host: windows, snapshot: windowsSnapshot, observedAt: 1_000 },
    { host, snapshot: macSnapshot, observedAt: 1_000 }
  ], 1_000, windows.hostId);
  assert.equal(merged[0]!.threadKey, macSnapshot.slots[0]!.threadKey);
  assert.equal(merged[0]!.host.platform, "darwin");
  assert.equal(merged[0]!.sourceSlot, 0);
});

test("combined custom mode keeps the controller assignment when both hosts configure one button", () => {
  const windows: CodexHost = { hostId: "11111111-1111-4111-8111-111111111111", hostName: "Windows", platform: "win32" };
  const windowsSnapshot = structuredClone(snapshot);
  const macSnapshot = structuredClone(snapshot);
  windowsSnapshot.agentSource = "custom";
  macSnapshot.agentSource = "custom";
  windowsSnapshot.slots[0] = { ...windowsSnapshot.slots[0]!, threadKey: "31000000-0000-4000-8000-000000000000" };
  macSnapshot.slots[0] = { ...macSnapshot.slots[0]!, threadKey: "32000000-0000-4000-8000-000000000000" };
  const merged = new HostActivityIndex().merge([
    { host: windows, snapshot: windowsSnapshot, observedAt: 1_000 },
    { host, snapshot: macSnapshot, observedAt: 1_000 }
  ], 1_000, windows.hostId);
  assert.equal(merged[0]!.threadKey, windowsSnapshot.slots[0]!.threadKey);
  assert.equal(merged[0]!.host.platform, "win32");
});

test("combined custom mode de-duplicates prefixed mirrors and routes them to the rollout owner", () => {
  const windows: CodexHost = { hostId: "11111111-1111-4111-8111-111111111111", hostName: "Windows", platform: "win32" };
  const windowsSnapshot = structuredClone(snapshot);
  const macSnapshot = structuredClone(snapshot);
  windowsSnapshot.agentSource = "custom";
  macSnapshot.agentSource = "custom";
  const id = "33000000-0000-4000-8000-000000000000";
  windowsSnapshot.slots[0] = { ...windowsSnapshot.slots[0]!, threadKey: `local:${id}`, ownedByHost: false };
  macSnapshot.slots[1] = { ...macSnapshot.slots[1]!, threadKey: `local:client-new-thread:${id}`, ownedByHost: true };
  const merged = new HostActivityIndex().merge([
    { host: windows, snapshot: windowsSnapshot, observedAt: 1_000 },
    { host, snapshot: macSnapshot, observedAt: 1_000 }
  ], 1_000, windows.hostId);
  assert.equal(merged.filter((slot) => slot.threadKey?.endsWith(id)).length, 1);
  assert.equal(merged[0]!.host.platform, "darwin");
  assert.equal(merged[0]!.sourceSlot, 1);
  assert.equal(merged[1]!.threadKey, windowsSnapshot.slots[1]!.threadKey);
});

test("active catalog native fallback de-duplicates stable mirrors but keeps temporary keys host-local", () => {
  const windows: CodexHost = {
    hostId: "11111111-1111-4111-8111-111111111111", hostName: "Windows", platform: "win32"
  };
  const stableId = "34000000-0000-4000-8000-000000000000";
  const temporaryId = "35000000-0000-4000-8000-000000000000";
  const windowsSnapshot = structuredClone(snapshot);
  const macSnapshot = structuredClone(snapshot);
  windowsSnapshot.slots[0] = {
    ...windowsSnapshot.slots[0]!, threadKey: `remote:${stableId}`, ownedByHost: false
  };
  macSnapshot.slots[0] = {
    ...macSnapshot.slots[0]!, threadKey: `local:${stableId}`, ownedByHost: true
  };
  windowsSnapshot.slots[1] = {
    ...windowsSnapshot.slots[1]!, threadKey: `remote:client-new-thread:${temporaryId}`
  };
  macSnapshot.slots[1] = {
    ...macSnapshot.slots[1]!, threadKey: `local:client-new-thread:${temporaryId}`
  };
  macSnapshot.hostSessions = [{
    threadId: stableId, activityAt: 1_000, status: "working", completionRevision: undefined
  }];

  const merged = new HostActivityIndex().mergeActiveCatalog([
    { host: windows, snapshot: windowsSnapshot, observedAt: 1_000 },
    { host, snapshot: macSnapshot, observedAt: 1_000 }
  ], 1_000, windows.hostId);

  const stable = merged.filter((slot) => slot.threadKey?.endsWith(stableId));
  assert.equal(stable.length, 1);
  assert.equal(stable[0]!.host.hostId, host.hostId);
  assert.equal(stable[0]!.conversationId, stableId);
  const temporary = merged.filter((slot) => slot.threadKey?.endsWith(temporaryId));
  assert.equal(temporary.length, 2);
  assert.deepEqual(new Set(temporary.map((slot) => slot.host.hostId)), new Set([windows.hostId, host.hostId]));
  assert.equal(temporary.every((slot) => slot.conversationId == null), true);
});

test("combined priority mode ranks waiting, unread, active, then idle", () => {
  const windows: CodexHost = { hostId: "11111111-1111-4111-8111-111111111111", hostName: "Windows", platform: "win32" };
  const windowsSnapshot = structuredClone(snapshot);
  const macSnapshot = structuredClone(snapshot);
  windowsSnapshot.agentSource = "priority";
  for (const slot of [...windowsSnapshot.slots, ...macSnapshot.slots]) {
    slot.status = "idle";
    slot.selected = false;
    slot.activityAt = 1;
  }
  macSnapshot.slots[0] = { ...macSnapshot.slots[0]!, threadKey: "40000000-0000-4000-8000-000000000000", status: "working" };
  macSnapshot.slots[1] = { ...macSnapshot.slots[1]!, threadKey: "40000000-0000-4000-8000-000000000001", status: "unread" };
  macSnapshot.slots[2] = { ...macSnapshot.slots[2]!, threadKey: "40000000-0000-4000-8000-000000000002", status: "awaiting-approval" };
  const merged = new HostActivityIndex().merge([
    { host: windows, snapshot: windowsSnapshot, observedAt: 1_000 },
    { host, snapshot: macSnapshot, observedAt: 1_000 }
  ], 1_000, windows.hostId);
  assert.deepEqual(merged.slice(0, 3).map((slot) => slot.status), ["awaiting-approval", "unread", "working"]);
});

test("combined priority mode keeps freshly completed owner sessions ahead of idle tasks", () => {
  const windows: CodexHost = { hostId: "11111111-1111-4111-8111-111111111111", hostName: "Windows", platform: "win32" };
  const windowsSnapshot = structuredClone(snapshot);
  const macSnapshot = structuredClone(snapshot);
  const completed = "50000000-0000-4000-8000-000000000000";
  windowsSnapshot.agentSource = "priority";
  macSnapshot.agentSource = "priority";
  for (const slot of [...windowsSnapshot.slots, ...macSnapshot.slots]) {
    slot.status = "idle";
    slot.selected = false;
    slot.activityAt = 1;
  }
  windowsSnapshot.slots[4] = { ...windowsSnapshot.slots[4]!, threadKey: completed, status: "idle" };
  macSnapshot.hostSessions = [{ threadId: completed, activityAt: 2_000, status: "complete" }];
  const merged = new HostActivityIndex().merge([
    { host: windows, snapshot: windowsSnapshot, observedAt: 2_000 },
    { host, snapshot: macSnapshot, observedAt: 2_000 }
  ], 2_000, windows.hostId);
  assert.equal(merged[0]!.threadKey, completed);
  assert.equal(merged[0]!.host.platform, "darwin");
  assert.equal(merged[0]!.status, "complete");
});

test("a completion opened through a cross-host mirror stays idle until a new completion revision", () => {
  const windows: CodexHost = { hostId: "11111111-1111-4111-8111-111111111111", hostName: "Windows", platform: "win32" };
  const windowsSnapshot = structuredClone(snapshot);
  const macSnapshot = structuredClone(snapshot);
  const completed = "50000000-0000-4000-8000-000000000001";
  for (const slot of [...windowsSnapshot.slots, ...macSnapshot.slots]) {
    slot.status = "idle";
    slot.selected = false;
    slot.activityAt = 1;
  }
  windowsSnapshot.slots[0] = { ...windowsSnapshot.slots[0]!, threadKey: "50000000-0000-4000-8000-000000000099" };
  windowsSnapshot.activeThreadKey = `local:${completed}`;
  macSnapshot.slots[0] = { ...macSnapshot.slots[0]!, threadKey: completed, ownedByHost: true };
  macSnapshot.hostSessions = [{ threadId: completed, activityAt: 1_900, status: "working" }];
  const index = new HostActivityIndex();
  const inputs = () => [
    { host: windows, snapshot: windowsSnapshot, observedAt: 2_000 },
    { host, snapshot: macSnapshot, observedAt: 2_000 }
  ];

  assert.equal(index.merge(inputs(), 2_000, windows.hostId).find((slot) => slot.threadKey === completed)?.status, "working");
  macSnapshot.hostSessions[0] = { threadId: completed, activityAt: 2_000, status: "complete", completionRevision: 10 };
  assert.equal(index.merge(inputs(), 2_001, windows.hostId).find((slot) => slot.threadKey === completed)?.status, "idle");
  delete windowsSnapshot.activeThreadKey;
  index.merge(inputs(), 2_002, windows.hostId);
  windowsSnapshot.activeThreadKey = `local:${completed}`;
  assert.equal(index.merge(inputs(), 2_003, windows.hostId).find((slot) => slot.threadKey === completed)?.status, "idle");
  delete windowsSnapshot.activeThreadKey;
  assert.equal(index.merge(inputs(), 2_004, windows.hostId).find((slot) => slot.threadKey === completed)?.status, "idle");

  macSnapshot.hostSessions[0]!.completionRevision = 20;
  assert.equal(index.merge(inputs(), 2_005, windows.hostId).find((slot) => slot.threadKey === completed)?.status, "complete");
  macSnapshot.slots[0]!.status = "working";
  assert.equal(index.merge(inputs(), 2_006, windows.hostId).find((slot) => slot.threadKey === completed)?.status, "working");
});

test("host lifecycle preserves fresh native approval attention", () => {
  const windows: CodexHost = { hostId: "11111111-1111-4111-8111-111111111111", hostName: "Windows", platform: "win32" };
  const windowsSnapshot = structuredClone(snapshot);
  const macSnapshot = structuredClone(snapshot);
  const threadId = "50000000-0000-4000-8000-000000000003";
  windowsSnapshot.slots[0] = { ...windowsSnapshot.slots[0]!, threadKey: threadId, status: "working" };
  macSnapshot.slots[0] = { ...macSnapshot.slots[0]!, threadKey: threadId, status: "awaiting-approval", ownedByHost: true };
  macSnapshot.hostSessions = [{ threadId, activityAt: 2_000, status: "idle" }];
  const merged = new HostActivityIndex().merge([
    { host: windows, snapshot: windowsSnapshot, observedAt: 2_000 },
    { host, snapshot: macSnapshot, observedAt: 2_000 }
  ], 2_000, windows.hostId);
  assert.equal(merged.find((slot) => slot.threadKey === threadId)?.status, "awaiting-approval");
});

test("an old session completion cannot resurrect a current native idle slot", () => {
  const windows: CodexHost = { hostId: "11111111-1111-4111-8111-111111111111", hostName: "Windows", platform: "win32" };
  const windowsSnapshot = structuredClone(snapshot);
  const macSnapshot = structuredClone(snapshot);
  const completed = "50000000-0000-4000-8000-000000000002";
  for (const slot of [...windowsSnapshot.slots, ...macSnapshot.slots]) {
    slot.status = "idle";
    slot.selected = false;
  }
  windowsSnapshot.slots[0] = { ...windowsSnapshot.slots[0]!, threadKey: completed, ownedByHost: false };
  macSnapshot.slots[0] = { ...macSnapshot.slots[0]!, threadKey: completed, ownedByHost: true };
  macSnapshot.hostSessions = [{
    threadId: completed, activityAt: 1_000, status: "complete", completionRevision: 10
  }];
  const observedAt = 1_000 + 5 * 60_000 + 1;
  const merged = new HostActivityIndex().merge([
    { host: windows, snapshot: windowsSnapshot, observedAt },
    { host, snapshot: macSnapshot, observedAt }
  ], observedAt, windows.hostId);

  assert.equal(merged.find((slot) => slot.threadKey === completed)?.status, "idle");
});

test("authenticated relay publishes snapshots and dispatches typed commands", async () => {
  const port = await freePort();
  const calls: unknown[] = [];
  const control = {
    refresh: async () => snapshot,
    sendAgent: async (slot: number, act: 0 | 1) => { calls.push(["agent", slot, act]); },
    sendAction: async () => {}, sendJoystick: async () => {}, sendEncoder: async () => {},
    adjustReasoning: async () => {}, runKeycap: async () => {}, consumeRateLimitReset: async () => {}
  };
  const server = new CodexRelayServer(
    { enabled: true, listenHost: "127.0.0.1", port, token: "t".repeat(32) }, host, control, () => {}
  );
  await server.start();
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  const messages = messageQueue(socket);
  await onceOpen(socket);
  socket.send(JSON.stringify({ type: "auth", protocol: RELAY_PROTOCOL_VERSION, token: "t".repeat(32) }));
  const first = await messages.next();
  assert.equal(first.type, "ready");
  assert.equal(first.bridge, "native-codex-micro");
  assert.deepEqual(first.capabilities, [
    "agent", "action", "joystick", "encoder", "reasoning", "keycap", "usage", "rate-limit-reset"
  ]);
  const second = await messages.next();
  assert.equal(second.type, "snapshot");
  socket.send(JSON.stringify({
    type: "command", protocol: RELAY_PROTOCOL_VERSION, requestId: "request-1",
    command: { kind: "agent", slot: 2, threadKey: "00000000-0000-4000-8000-000000000002", act: 1 }
  }));
  const result = await messages.next();
  assert.deepEqual(calls, [["agent", 2, 1]]);
  assert.equal(result.type, "result");
  assert.equal(result.ok, true);
  socket.close();
  await server.close();
});

test("relay snapshot wire encoding drops an oversized active catalog but preserves the base six slots", () => {
  const oversized = structuredClone(snapshot);
  oversized.hostSessions = Array.from({ length: 128 }, (_, index) => ({
    threadId: `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`,
    activityAt: index + 1,
    status: "working" as const
  }));
  oversized.activeCatalog = {
    complete: true,
    candidates: Array.from({ length: 64 }, (_, catalogIndex) => ({
      threadKey: `local:10000000-0000-4000-8000-${catalogIndex.toString().padStart(12, "0")}`,
      title: "catalog title ".repeat(80),
      status: "working",
      selected: false,
      activityAt: catalogIndex + 1,
      catalogIndex
    }))
  };
  const message: RelaySnapshotMessage = {
    type: "snapshot", protocol: RELAY_PROTOCOL_VERSION, host, observedAt: 1, snapshot: oversized
  };
  assert.ok(Buffer.byteLength(JSON.stringify(message), "utf8") > 64 * 1024);

  const encoded = encodeRelaySnapshotMessage(message);
  const decoded = JSON.parse(encoded) as RelaySnapshotMessage;

  assert.ok(Buffer.byteLength(encoded, "utf8") <= 64 * 1024);
  assert.equal(decoded.snapshot.activeCatalog, undefined);
  assert.deepEqual(decoded.snapshot.slots, snapshot.slots);
  assert.deepEqual(decoded.snapshot.hostSessions, oversized.hostSessions);
});

test("relay snapshot wire encoding keeps an active catalog that fits", () => {
  const normal = structuredClone(snapshot);
  normal.activeCatalog = { complete: true, candidates: [{
    threadKey: "local:10000000-0000-4000-8000-000000000001",
    title: "Catalog task", status: "working", selected: false, catalogIndex: 6
  }] };
  const message: RelaySnapshotMessage = {
    type: "snapshot", protocol: RELAY_PROTOCOL_VERSION, host, observedAt: 1, snapshot: normal
  };

  const decoded = JSON.parse(encodeRelaySnapshotMessage(message)) as RelaySnapshotMessage;

  assert.deepEqual(decoded.snapshot.activeCatalog, normal.activeCatalog);
});

test("relay snapshot wire encoding preserves content-free work-start metadata within budget", () => {
  const normal = structuredClone(snapshot);
  normal.hostSessions = Array.from({ length: 128 }, (_, index) => ({
    threadId: `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`,
    activityAt: 2_000, status: "working" as const,
    workStartedAt: 1_000 + index, workStartRevision: index
  }));
  const encoded = encodeRelaySnapshotMessage({
    type: "snapshot", protocol: RELAY_PROTOCOL_VERSION, host, observedAt: 2_000, snapshot: normal
  });
  const decoded = JSON.parse(encoded) as RelaySnapshotMessage;
  assert.ok(Buffer.byteLength(encoded, "utf8") <= 64 * 1024);
  assert.equal(decoded.snapshot.hostSessions?.[127]?.workStartedAt, 1_127);
  assert.equal(decoded.snapshot.hostSessions?.[127]?.workStartRevision, 127);
});

test("relay snapshot wire encoding rejects an oversized base snapshot", () => {
  const oversized = structuredClone(snapshot);
  oversized.slots[0]!.title = "oversized base ".repeat(5_000);
  const message: RelaySnapshotMessage = {
    type: "snapshot", protocol: RELAY_PROTOCOL_VERSION, host, observedAt: 1, snapshot: oversized
  };

  assert.throws(() => encodeRelaySnapshotMessage(message), /exceeds the 65536-byte wire payload limit/);
});

test("running relay publishes refreshed Codex metadata without changing host identity", async () => {
  const port = await freePort();
  const control = {
    refresh: async () => snapshot,
    sendAgent: async () => {}, sendAction: async () => {}, sendJoystick: async () => {},
    sendEncoder: async () => {}, adjustReasoning: async () => {}, runKeycap: async () => {}, consumeRateLimitReset: async () => {}
  };
  const server = new CodexRelayServer(
    { enabled: true, listenHost: "127.0.0.1", port, token: "t".repeat(32) },
    { ...host, codexVersion: "old" }, control, () => {}
  );
  await server.start();
  server.updateHost({ ...host, hostName: "Renamed Mac", codexVersion: "new" });
  assert.throws(
    () => server.updateHost({ ...host, hostId: "56fd97ad-7073-42cc-85ce-befa17546d7d" }),
    /identity cannot change/
  );
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  const messages = messageQueue(socket);
  await onceOpen(socket);
  socket.send(JSON.stringify({ type: "auth", protocol: RELAY_PROTOCOL_VERSION, token: "t".repeat(32) }));
  const ready = await messages.next();
  const readyHost = ready.host as CodexHost;
  assert.equal(readyHost.hostName, "Renamed Mac");
  assert.equal(readyHost.codexVersion, "new");
  const published = await messages.next();
  assert.equal((published.host as CodexHost).codexVersion, "new");
  socket.close();
  await server.close();
});

test("relay rejects a client with the wrong token before publishing state", async () => {
  const port = await freePort();
  let refreshes = 0;
  const control = {
    refresh: async () => { refreshes += 1; return snapshot; },
    sendAgent: async () => {}, sendAction: async () => {}, sendJoystick: async () => {},
    sendEncoder: async () => {}, adjustReasoning: async () => {}, runKeycap: async () => {}, consumeRateLimitReset: async () => {}
  };
  const server = new CodexRelayServer(
    { enabled: true, listenHost: "127.0.0.1", port, token: "t".repeat(32) }, host, control, () => {}
  );
  await server.start();
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  await onceOpen(socket);
  socket.send(JSON.stringify({ type: "auth", protocol: RELAY_PROTOCOL_VERSION, token: "wrong-token".repeat(4) }));
  const closeCode = await new Promise<number>((resolve) => socket.once("close", resolve));
  assert.equal(closeCode, 4003);
  assert.equal(refreshes, 0);
  await server.close();
});

test("authenticated relay survives an unavailable Codex snapshot", async () => {
  const port = await freePort();
  const logs: string[] = [];
  const control = {
    refresh: async (): Promise<MicroSnapshot> => { throw new Error("bridge offline"); },
    sendAgent: async () => {}, sendAction: async () => {}, sendJoystick: async () => {},
    sendEncoder: async () => {}, adjustReasoning: async () => {}, runKeycap: async () => {}, consumeRateLimitReset: async () => {}
  };
  const server = new CodexRelayServer(
    { enabled: true, listenHost: "127.0.0.1", port, token: "t".repeat(32) }, host, control,
    (message) => logs.push(message)
  );
  await server.start();
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  const messages = messageQueue(socket);
  await onceOpen(socket);
  socket.send(JSON.stringify({ type: "auth", protocol: RELAY_PROTOCOL_VERSION, token: "t".repeat(32) }));
  assert.equal((await messages.next()).type, "ready");
  const health = await messages.next();
  assert.equal(health.type, "health");
  assert.equal(health.state, "degraded");
  assert.equal(health.reason, "native-signals-unavailable");
  assert.equal(socket.readyState, WebSocket.OPEN);
  assert.equal(logs.filter((message) => message.includes("bridge offline")).length, 1);
  socket.close();
  await server.close();
});

test("relay client preserves last-known tasks but marks their host offline after disconnect", async () => {
  const port = await freePort();
  const control = {
    refresh: async () => snapshot,
    sendAgent: async () => {}, sendAction: async () => {}, sendJoystick: async () => {},
    sendEncoder: async () => {}, adjustReasoning: async () => {}, runKeycap: async () => {}, consumeRateLimitReset: async () => {}
  };
  const server = new CodexRelayServer(
    { enabled: true, listenHost: "127.0.0.1", port, token: "t".repeat(32) }, host, control, () => {}
  );
  const deliveredSnapshots: HostSnapshot[] = [];
  const client = new CodexRelayClient(
    { enabled: true, url: `ws://127.0.0.1:${port}`, token: "t".repeat(32) },
    (value) => deliveredSnapshots.push(value), () => {}
  );
  let originalServerStarted = false;
  let replacementServer: CodexRelayServer | undefined;
  try {
    await server.start();
    originalServerStarted = true;
    client.start();
    await waitUntil(() => client.currentHealth().state === "ready");
    assert.equal(deliveredSnapshots.length, 1);
    const lastKnown = client.currentSnapshot();
    assert.equal(lastKnown?.snapshot.slots[0]?.title, "Task 1");
    await server.close();
    originalServerStarted = false;
    await waitUntil(() => client.currentHealth().state === "offline");
    assert.equal(deliveredSnapshots.length, 1, "health-only transitions must not call the snapshot callback");
    assert.equal(client.currentSnapshot(), lastKnown);
    assert.equal(client.currentHost(), undefined);
    assert.equal(client.isConnected(), false);
    const replacementHost: CodexHost = {
      hostId: "11111111-1111-4111-8111-111111111111", hostName: "Replacement Mac", platform: "darwin"
    };
    replacementServer = new CodexRelayServer(
      { enabled: true, listenHost: "127.0.0.1", port, token: "t".repeat(32) },
      replacementHost, control, () => {}
    );
    await replacementServer.start();
    await waitUntil(() => client.currentHealth().state === "ready", 3_000);
    assert.equal(client.currentHost()?.hostId, replacementHost.hostId);
    assert.equal(deliveredSnapshots.length, 2);
  } finally {
    client.close();
    if (replacementServer) await replacementServer.close();
    if (originalServerStarted) await server.close();
  }
});

test("relay client rejects a command when the authenticated host does not match its expected owner", async () => {
  const port = await freePort();
  const calls: unknown[] = [];
  const control = {
    refresh: async () => snapshot,
    sendAgent: async () => {},
    sendAction: async (slot: string, act: 0 | 1) => { calls.push([slot, act]); },
    sendJoystick: async () => {}, sendEncoder: async () => {}, adjustReasoning: async () => {},
    runKeycap: async () => {}, consumeRateLimitReset: async () => {}
  };
  const server = new CodexRelayServer(
    { enabled: true, listenHost: "127.0.0.1", port, token: "t".repeat(32) }, host, control, () => {}
  );
  const client = new CodexRelayClient(
    { enabled: true, url: `ws://127.0.0.1:${port}`, token: "t".repeat(32) }, () => {}, () => {}
  );
  try {
    await server.start();
    client.start();
    await waitUntil(() => client.currentHealth().state === "ready");
    await assert.rejects(
      client.send({ kind: "action", slot: "ACT10_ACT11", act: 1 }, "different-host"),
      /expected remote Codex host/
    );
    assert.deepEqual(calls, [], "a mismatched owner must be rejected before socket.send");
  } finally {
    client.close();
    await server.close();
  }
});

test("relay client ignores state and command results from a replaced socket", async () => {
  const delivered: HostSnapshot[] = [];
  const client = new CodexRelayClient(
    { enabled: true, url: "ws://127.0.0.1:47651", token: "t".repeat(32) },
    (value) => delivered.push(value), () => {}
  );
  const firstSocket = { readyState: WebSocket.OPEN } as WebSocket;
  const replacementSocket = { readyState: WebSocket.OPEN } as WebSocket;
  const internal = client as unknown as {
    socket?: WebSocket;
    readySocket?: WebSocket;
    host?: CodexHost;
    pending: Map<string, { resolve: () => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>;
    handleMessage: (socket: WebSocket, raw: string) => void;
  };
  const deliver = (socket: WebSocket, message: unknown): void => {
    internal.handleMessage(socket, JSON.stringify(message));
  };
  internal.socket = firstSocket;
  deliver(firstSocket, {
    type: "ready", protocol: RELAY_PROTOCOL_VERSION, host,
    capabilities: [], bridge: "native-codex-micro"
  });
  internal.socket = replacementSocket;
  internal.readySocket = replacementSocket;
  const replacementHost: CodexHost = {
    hostId: "11111111-1111-4111-8111-111111111111", hostName: "Replacement", platform: "win32"
  };
  internal.host = replacementHost;
  let staleResultResolved = false;
  const timer = setTimeout(() => {}, 1_000);
  internal.pending.set("stale-request", {
    resolve: () => { staleResultResolved = true; }, reject: () => {}, timer
  });
  try {
    deliver(firstSocket, {
      type: "snapshot", protocol: RELAY_PROTOCOL_VERSION, host,
      snapshot, observedAt: Date.now()
    });
    deliver(firstSocket, {
      type: "result", protocol: RELAY_PROTOCOL_VERSION, requestId: "stale-request", ok: true
    });
    assert.equal(client.currentHost()?.hostId, replacementHost.hostId);
    assert.equal(delivered.length, 0);
    assert.equal(staleResultResolved, false);
    assert.equal(internal.pending.has("stale-request"), true);
  } finally {
    clearTimeout(timer);
    internal.pending.clear();
  }
});

test("relay client ignores state and command results before the current socket is ready", () => {
  const delivered: HostSnapshot[] = [];
  const client = new CodexRelayClient(
    { enabled: true, url: "ws://127.0.0.1:47651", token: "t".repeat(32) },
    (value) => delivered.push(value), () => {}
  );
  const socket = { readyState: WebSocket.OPEN } as WebSocket;
  const internal = client as unknown as {
    socket?: WebSocket;
    pending: Map<string, { resolve: () => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>;
    handleMessage: (socket: WebSocket, raw: string) => void;
  };
  const deliver = (message: unknown): void => {
    internal.handleMessage(socket, JSON.stringify(message));
  };
  internal.socket = socket;
  let prematureResultResolved = false;
  const timer = setTimeout(() => {}, 1_000);
  internal.pending.set("premature-request", {
    resolve: () => { prematureResultResolved = true; }, reject: () => {}, timer
  });
  try {
    deliver({
      type: "snapshot", protocol: RELAY_PROTOCOL_VERSION, host,
      snapshot, observedAt: Date.now()
    });
    deliver({
      type: "health", protocol: RELAY_PROTOCOL_VERSION, host,
      state: "degraded", reason: "codex-unavailable"
    });
    deliver({
      type: "result", protocol: RELAY_PROTOCOL_VERSION, requestId: "premature-request", ok: true
    });
    assert.equal(client.currentHost(), undefined);
    assert.equal(client.currentSnapshot(), undefined);
    assert.equal(client.currentHealth().state, "connecting");
    assert.equal(delivered.length, 0);
    assert.equal(prematureResultResolved, false);
    assert.equal(internal.pending.has("premature-request"), true);
  } finally {
    clearTimeout(timer);
    internal.pending.clear();
  }
});

test("agent release keeps the host owner captured on press", async () => {
  const controller = new DeckController();
  const remoteHost: CodexHost = {
    hostId: "22222222-2222-4222-8222-222222222222", hostName: "Remote A", platform: "darwin"
  };
  const assignment = {
    ...snapshot.slots[0]!, host: remoteHost, sourceSlot: 0, observedAt: Date.now()
  };
  const sends: Array<[unknown, string | undefined]> = [];
  const internal = controller as unknown as {
    activeQueueEnabled: boolean;
    localHost?: CodexHost;
    routedSlots: typeof assignment[];
    relayClient?: { send: (command: unknown, expectedHostId?: string) => Promise<void> };
    refresh: () => Promise<void>;
  };
  internal.localHost = {
    hostId: "33333333-3333-4333-8333-333333333333", hostName: "Local", platform: "win32"
  };
  internal.activeQueueEnabled = true;
  internal.routedSlots = [assignment];
  internal.relayClient = {
    send: async (command, expectedHostId) => { sends.push([command, expectedHostId]); }
  };
  internal.refresh = async () => {};

  await controller.sendAgent(0, 1);
  internal.routedSlots = [{
    ...assignment,
    sourceSlot: 5,
    threadKey: "00000000-0000-4000-8000-000000000005",
    host: { ...remoteHost, hostId: "44444444-4444-4444-8444-444444444444", hostName: "Remote B" }
  }];
  await controller.sendAgent(0, 0);

  assert.deepEqual(sends.map(([command, expectedHostId]) => [
    (command as { act: number; slot: number; threadKey: string }).act,
    (command as { act: number; slot: number; threadKey: string }).slot,
    (command as { act: number; slot: number; threadKey: string }).threadKey,
    expectedHostId
  ]), [
    [1, assignment.sourceSlot, assignment.threadKey, remoteHost.hostId],
    [0, assignment.sourceSlot, assignment.threadKey, remoteHost.hostId]
  ]);
});

test("active queue empty press stays a no-op across queue disable and a filled release", async () => {
  const controller = new DeckController();
  const sends: unknown[] = [];
  let alerts = 0;
  const internal = controller as unknown as {
    activeQueueEnabled: boolean;
    routedSlots: RoutedAgentSlot[];
    pressedAgents: Map<number, unknown>;
    emptyAgentPresses: Set<number>;
    localHost?: CodexHost;
    microBridge: { sendAgent: (...args: unknown[]) => Promise<void> };
  };
  internal.localHost = host;
  internal.routedSlots = [];
  internal.microBridge.sendAgent = async (...args) => { sends.push(args); };

  internal.activeQueueEnabled = false;
  await assert.rejects(controller.sendAgent(0, 1), /No Codex task is assigned/);
  internal.activeQueueEnabled = true;

  const action = new Agent1(controller);
  const event = { action: { showAlert: async () => { alerts += 1; } } };
  await action.onKeyDown(event as never);
  assert.equal(internal.pressedAgents.size, 0);
  assert.equal(internal.emptyAgentPresses.has(0), true);
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
    pressedAgents: Map<number, RoutedAgentSlot>;
    emptyAgentPresses: Set<number>;
    localHost?: CodexHost;
    microBridge: { sendAgent: (...args: unknown[]) => Promise<void> };
  };
  internal.activeQueueEnabled = true;
  internal.localHost = host;
  internal.routedSlots = [];
  internal.pressedAgents.set(0, orphaned);
  internal.microBridge.sendAgent = async (...args) => { sends.push(args); };

  await controller.sendAgent(0, 1);
  assert.equal(internal.pressedAgents.size, 0);
  assert.equal(internal.emptyAgentPresses.has(0), true);
  await controller.sendAgent(0, 0);

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
    targetHostId?: string;
    targetPlatform: CodexHost["platform"];
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
  internal.targetHostId = host.hostId;
  internal.targetPlatform = host.platform;
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
  const foregrounded: string[] = [];
  const acknowledged: string[] = [];
  const published: string[] = [];
  const controller = new DeckController({
    foregroundOpenCode: async () => { foregrounded.push("foregrounded"); }
  });
  const internal = controller as unknown as {
    activeQueueEnabled: boolean;
    localHost?: CodexHost;
    targetHostId?: string;
    targetPlatform: CodexHost["platform"];
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
  internal.targetHostId = host.hostId;
  internal.targetPlatform = host.platform;
  internal.openCodeHealth = { state: "ready" };
  internal.openCodeCollector = {
    acknowledgeTask(connectionId, sessionId, terminalAt) {
      acknowledged.push(`${connectionId}:${sessionId}:${terminalAt}`);
      return true;
    },
    async publishTaskViewed(connectionId, sessionId) {
      published.push(`${connectionId}:${sessionId}`);
      return true;
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

  await controller.sendAgent(0, 1);

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
    targetHostId?: string;
    targetPlatform: CodexHost["platform"];
    localHealth: { state: "ready" | "degraded" | "offline" | "connecting"; reason?: string };
    routedSlots: unknown[];
    renderAgent: (registration: { action: unknown; slot: number }) => Promise<void>;
  };
  internal.activeQueueEnabled = true;
  internal.localHost = host;
  internal.targetHostId = host.hostId;
  internal.targetPlatform = host.platform;
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
    targetHostId?: string;
    targetPlatform: CodexHost["platform"];
    localHealth: { state: "ready" | "degraded" | "offline" | "connecting"; reason?: string };
    routedSlots: RoutedAgentSlot[];
    relayClient?: {
      currentHost: () => CodexHost | undefined;
      currentHealth: () => { state: "ready" | "degraded" | "offline" | "connecting"; reason?: string };
      currentSnapshot: () => undefined;
    };
    renderAgent: (registration: { action: unknown; slot: number }) => Promise<void>;
  };
  internal.activeQueueEnabled = false;
  internal.localHost = host;
  internal.targetHostId = host.hostId;
  internal.targetPlatform = host.platform;
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

  const remoteHost: CodexHost = {
    hostId: "22222222-2222-4222-8222-222222222222", hostName: "Remote", platform: "win32"
  };
  internal.routedSlots = [{ ...snapshot.slots[0]!, host: remoteHost, sourceSlot: 0, observedAt: Date.now() }];
  internal.relayClient = {
    currentHost: () => remoteHost,
    currentHealth: () => ({ state: "offline", reason: "relay-disconnected" }),
    currentSnapshot: () => undefined
  };
  internal.localHealth = { state: "degraded", reason: "codex-not-running" };
  const remoteOffline = await render(0);
  assert.match(remoteOffline, /data-agent-host-health="offline"/);
  assert.doesNotMatch(remoteOffline, /<rect width="144" height="144" fill="#000000"\/>/);
});

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function onceOpen(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) return;
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for relay state.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function messageQueue(socket: WebSocket): { next: () => Promise<Record<string, unknown>> } {
  const queued: Record<string, unknown>[] = [];
  const waiting: Array<(value: Record<string, unknown>) => void> = [];
  socket.on("message", (raw) => {
    const value = JSON.parse(raw.toString()) as Record<string, unknown>;
    const resolve = waiting.shift();
    if (resolve) resolve(value);
    else queued.push(value);
  });
  return {
    next: () => {
      const value = queued.shift();
      if (value) return Promise.resolve(value);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Timed out waiting for relay message.")), 2_000);
        waiting.push((message) => { clearTimeout(timer); resolve(message); });
      });
    }
  };
}
