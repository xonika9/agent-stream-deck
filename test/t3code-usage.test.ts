import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WebSocketServer } from "ws";
import { T3UsageReader } from "#t3code";

const FIXTURE_URL = new URL("./support/t3-getconfig-exit.json", import.meta.url);

async function loadSample(): Promise<unknown> {
  return JSON.parse(await readFile(FIXTURE_URL, "utf8"));
}

type TicketMode = "ok" | "unauthorized" | "hang" | "redirect";
type WsMode =
  | "sample"
  | "ping-then-sample"
  | "error-exit"
  | "malformed-exit"
  | "hang"
  | "oversize"
  | "delayed"
  | "unavailable";

type UsageServer = {
  origin: string;
  state: {
    ticketMode: TicketMode;
    wsMode: WsMode;
    ticketRequests: number;
    configRequests: number;
    pongs: number;
    authorizations: string[];
    wsTickets: string[];
    redirectHits: number;
  };
  close: () => Promise<void>;
};

async function startUsageServer(sample: unknown): Promise<UsageServer> {
  const state = {
    ticketMode: "ok" as TicketMode,
    wsMode: "sample" as WsMode,
    ticketRequests: 0,
    configRequests: 0,
    pongs: 0,
    authorizations: [] as string[],
    wsTickets: [] as string[],
    redirectHits: 0,
  };
  const redirectTarget = createServer((_req, res) => {
    state.redirectHits++;
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  await new Promise<void>((resolve) => redirectTarget.listen(0, "127.0.0.1", resolve));
  const redirectAddress = redirectTarget.address();
  assert.ok(redirectAddress && typeof redirectAddress !== "string");
  const redirectOrigin = `http://127.0.0.1:${redirectAddress.port}`;
  const server = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/api/auth/websocket-ticket") {
      state.ticketRequests++;
      state.authorizations.push(String(req.headers.authorization ?? ""));
      if (state.ticketMode === "unauthorized") {
        res.writeHead(401, { "content-type": "application/json" });
        res.end("{}");
      } else if (state.ticketMode === "redirect") {
        res.writeHead(302, { location: `${redirectOrigin}/elsewhere` });
        res.end();
      } else if (state.ticketMode === "hang") {
        // Never respond; the reader must time out on its own.
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ticket: "fixture-ticket", expiresAt: new Date(Date.now() + 60_000).toISOString() }));
      }
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const wss = new WebSocketServer({ server });
  const unavailableExit = {
    _tag: "Exit",
    requestId: "1",
    exit: {
      _tag: "Success",
      value: {
        providers: [
          {
            driver: "codex",
            instanceId: "codex",
            usageLimits: {
              checkedAt: "2026-11-13T01:39:13.318Z",
              windows: [
                {
                  id: "primary",
                  kind: "session",
                  label: "Session",
                  usedPercent: 13,
                  resetsAt: "2026-11-13T06:22:20.000Z",
                  windowDurationMins: 300,
                },
              ],
              unavailable: { reason: "paused", message: "Private detail" },
            },
          },
        ],
      },
    },
  };
  const exitFrame = () => {
    if (state.wsMode === "error-exit") return { _tag: "Exit", requestId: "1", exit: { _tag: "Failure" } };
    if (state.wsMode === "malformed-exit")
      return { _tag: "Exit", requestId: "1", exit: { _tag: "Success", value: { providers: "nope" } } };
    if (state.wsMode === "unavailable") return unavailableExit;
    return structuredClone(sample);
  };
  wss.on("connection", (socket, req) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    state.wsTickets.push(url.searchParams.get("wsTicket") ?? "");
    socket.on("message", (raw) => {
      let frame: { _tag?: string; tag?: string } | undefined;
      try {
        frame = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (frame?._tag === "Pong") {
        state.pongs++;
        return;
      }
      if (frame?.tag !== "server.getConfig") return;
      state.configRequests++;
      const sendExit = () => {
        if (socket.readyState === socket.OPEN) {
          if (state.wsMode === "oversize") socket.send(`{"_tag":"Exit","x":"${"x".repeat(8 * 1024 * 1024 + 8)}"}`);
          else socket.send(JSON.stringify(exitFrame()));
        }
      };
      if (state.wsMode === "ping-then-sample" && socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify({ _tag: "Ping" }));
        setTimeout(sendExit, 20);
      } else if (state.wsMode === "delayed") {
        setTimeout(sendExit, 250);
      } else if (state.wsMode !== "hang") {
        sendExit();
      }
    });
  });
  return {
    origin: `http://127.0.0.1:${address.port}`,
    state,
    close: async () => {
      wss.close();
      server.closeAllConnections();
      redirectTarget.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await new Promise<void>((resolve) => redirectTarget.close(() => resolve()));
    },
  };
}

async function writeConnection(root: string, origin: string): Promise<{ configPath: string; runtimePath: string }> {
  const configPath = join(root, "t3code.json");
  const runtimePath = join(root, "runtime.json");
  await writeFile(configPath, JSON.stringify({ origin, token: "fixture-token" }), { mode: 0o600 });
  await writeFile(runtimePath, JSON.stringify({ version: 1, pid: process.pid, origin }));
  return { configPath, runtimePath };
}

function secretFree(logs: string[]): void {
  for (const line of logs)
    assert.equal(
      /fixture-token|fixture-ticket|127\.0\.0\.1/u.test(line),
      false,
      `log must not carry secrets or addresses: ${line}`,
    );
}

test("T3 usage reader normalizes the sample windows per provider", {
  skip: process.platform === "win32" ? "T3 usage reader is macOS-only" : false,
}, async () => {
  const sample = await loadSample();
  const usage = await startUsageServer(sample);
  const root = await mkdtemp(join(tmpdir(), "deck-t3-usage-"));
  const logs: string[] = [];
  try {
    const { configPath, runtimePath } = await writeConnection(root, usage.origin);
    const reader = new T3UsageReader((message) => logs.push(message), { configPath, runtimePath });
    usage.state.wsMode = "ping-then-sample";
    await reader.refresh();
    assert.equal(reader.health.state, "ready");
    assert.deepEqual(logs, []);
    assert.equal(usage.state.ticketRequests, 1);
    assert.equal(usage.state.configRequests, 1);
    assert.equal(usage.state.pongs, 1);
    assert.deepEqual(usage.state.authorizations, ["Bearer fixture-token"]);
    assert.ok(usage.state.wsTickets.every((ticket) => ticket === "fixture-ticket"));
    assert.deepEqual(reader.snapshots["t3-codex"], {
      windows: [
        {
          id: "primary",
          kind: "five-hour",
          usedPercent: 13,
          remainingPercent: 87,
          windowDurationMins: 300,
          resetsAt: Date.parse("2026-11-13T06:22:20.000Z"),
        },
        {
          id: "secondary",
          kind: "weekly",
          usedPercent: 95,
          remainingPercent: 5,
          windowDurationMins: 10080,
          resetsAt: Date.parse("2026-11-18T08:49:27.000Z"),
        },
      ],
      observedAt: Date.parse("2026-11-13T01:39:13.318Z"),
      resetCreditsAvailable: 3,
      resetCreditsApplicable: null,
    });
    assert.deepEqual(reader.snapshots["t3-claude"], {
      windows: [
        {
          id: "five_hour",
          kind: "five-hour",
          usedPercent: 7,
          remainingPercent: 93,
          windowDurationMins: 300,
          resetsAt: Date.parse("2026-11-13T05:50:00.179Z"),
        },
        {
          id: "seven_day",
          kind: "weekly",
          usedPercent: 2,
          remainingPercent: 98,
          windowDurationMins: 10080,
          resetsAt: Date.parse("2026-11-17T16:00:00.179Z"),
        },
        {
          id: "seven_day_fable",
          kind: "weekly-fable",
          usedPercent: 2,
          remainingPercent: 98,
          windowDurationMins: 10080,
          resetsAt: Date.parse("2026-11-17T16:00:00.179Z"),
        },
      ],
      observedAt: Date.parse("2026-11-13T01:38:11.034Z"),
      resetCreditsAvailable: null,
      resetCreditsApplicable: null,
    });
    assert.deepEqual(reader.snapshots["t3-opencode"], {
      windows: [
        {
          id: "go_rolling",
          kind: "five-hour",
          usedPercent: 1,
          remainingPercent: 99,
          windowDurationMins: 300,
          resetsAt: Date.parse("2026-11-13T06:14:49.000Z"),
        },
        {
          id: "go_weekly",
          kind: "weekly",
          usedPercent: 19,
          remainingPercent: 81,
          windowDurationMins: 10080,
          resetsAt: Date.parse("2026-11-16T00:00:00.000Z"),
        },
        {
          id: "go_monthly",
          kind: "monthly",
          usedPercent: 9,
          remainingPercent: 91,
          windowDurationMins: null,
          resetsAt: Date.parse("2026-12-11T23:45:33.000Z"),
        },
      ],
      observedAt: Date.parse("2026-11-13T01:33:49.195Z"),
      resetCreditsAvailable: null,
      resetCreditsApplicable: null,
    });
    await reader.refresh();
    assert.equal(usage.state.ticketRequests, 2, "every poll uses a new ticket");
  } finally {
    await usage.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("T3 usage reader goes offline when the ticket is rejected", {
  skip: process.platform === "win32" ? "T3 usage reader is macOS-only" : false,
}, async () => {
  const usage = await startUsageServer(await loadSample());
  const root = await mkdtemp(join(tmpdir(), "deck-t3-usage-cred-"));
  const logs: string[] = [];
  try {
    const { configPath, runtimePath } = await writeConnection(root, usage.origin);
    const reader = new T3UsageReader((message) => logs.push(message), { configPath, runtimePath });
    usage.state.ticketMode = "unauthorized";
    await reader.refresh();
    assert.equal(reader.health.state, "offline");
    assert.deepEqual(reader.snapshots, {});
    assert.deepEqual(logs, [
      "T3 usage connection unavailable: credential rejected; reconnect with npm run connect:t3.",
    ]);
    await reader.refresh();
    assert.equal(logs.length, 1, "each failure is logged once");
    secretFree(logs);
  } finally {
    await usage.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("T3 usage reader keeps the previous snapshot on timeout", {
  skip: process.platform === "win32" ? "T3 usage reader is macOS-only" : false,
}, async () => {
  const usage = await startUsageServer(await loadSample());
  const root = await mkdtemp(join(tmpdir(), "deck-t3-usage-timeout-"));
  const logs: string[] = [];
  try {
    const { configPath, runtimePath } = await writeConnection(root, usage.origin);
    const reader = new T3UsageReader((message) => logs.push(message), { configPath, runtimePath });
    await reader.refresh();
    assert.equal(reader.health.state, "ready");
    const kept = reader.snapshots;
    usage.state.wsMode = "hang";
    await reader.refresh();
    assert.equal(reader.health.state, "degraded");
    assert.equal(reader.snapshots, kept, "the last good snapshot is retained");
    assert.deepEqual(logs, ["T3 usage connection unavailable: request timed out."]);
    secretFree(logs);
  } finally {
    await usage.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("T3 usage reader rejects an oversized response without parsing", {
  skip: process.platform === "win32" ? "T3 usage reader is macOS-only" : false,
}, async () => {
  const usage = await startUsageServer(await loadSample());
  const root = await mkdtemp(join(tmpdir(), "deck-t3-usage-huge-"));
  const logs: string[] = [];
  try {
    const { configPath, runtimePath } = await writeConnection(root, usage.origin);
    const reader = new T3UsageReader((message) => logs.push(message), { configPath, runtimePath });
    await reader.refresh();
    assert.equal(reader.health.state, "ready");
    const kept = reader.snapshots;
    usage.state.wsMode = "oversize";
    await reader.refresh();
    assert.equal(reader.health.state, "degraded");
    assert.equal(reader.snapshots, kept);
    assert.deepEqual(logs, ["T3 usage connection unavailable: response is unsupported or too large."]);
    secretFree(logs);
  } finally {
    await usage.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("T3 usage reader degrades on a failed or malformed Exit", {
  skip: process.platform === "win32" ? "T3 usage reader is macOS-only" : false,
}, async () => {
  const usage = await startUsageServer(await loadSample());
  const root = await mkdtemp(join(tmpdir(), "deck-t3-usage-exit-"));
  const logs: string[] = [];
  try {
    const { configPath, runtimePath } = await writeConnection(root, usage.origin);
    const reader = new T3UsageReader((message) => logs.push(message), { configPath, runtimePath });
    usage.state.wsMode = "error-exit";
    await reader.refresh();
    assert.equal(reader.health.state, "degraded");
    assert.deepEqual(reader.snapshots, {});
    usage.state.wsMode = "malformed-exit";
    await reader.refresh();
    assert.equal(reader.health.state, "degraded");
    assert.deepEqual(logs, ["T3 usage connection unavailable: response is unsupported or too large."]);
    secretFree(logs);
  } finally {
    await usage.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("T3 usage reader refuses a non-loopback origin without a network request", {
  skip: process.platform === "win32" ? "T3 usage reader is macOS-only" : false,
}, async () => {
  const usage = await startUsageServer(await loadSample());
  const root = await mkdtemp(join(tmpdir(), "deck-t3-usage-origin-"));
  const logs: string[] = [];
  try {
    const { configPath, runtimePath } = await writeConnection(root, "http://192.0.2.1:3773");
    const reader = new T3UsageReader((message) => logs.push(message), { configPath, runtimePath });
    await reader.refresh();
    assert.equal(reader.health.state, "offline");
    assert.deepEqual(reader.snapshots, {});
    assert.equal(usage.state.ticketRequests, 0);
    secretFree(logs);
  } finally {
    await usage.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("T3 usage reader does not follow a ticket redirect", {
  skip: process.platform === "win32" ? "T3 usage reader is macOS-only" : false,
}, async () => {
  const usage = await startUsageServer(await loadSample());
  const root = await mkdtemp(join(tmpdir(), "deck-t3-usage-redirect-"));
  const logs: string[] = [];
  try {
    const { configPath, runtimePath } = await writeConnection(root, usage.origin);
    const reader = new T3UsageReader((message) => logs.push(message), { configPath, runtimePath });
    usage.state.ticketMode = "redirect";
    await reader.refresh();
    assert.equal(reader.health.state, "degraded");
    assert.deepEqual(reader.snapshots, {});
    assert.equal(usage.state.redirectHits, 0, "the ticket request must not be redirected");
    secretFree(logs);
  } finally {
    await usage.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("T3 usage reader coalesces a poll while one is pending", {
  skip: process.platform === "win32" ? "T3 usage reader is macOS-only" : false,
}, async () => {
  const usage = await startUsageServer(await loadSample());
  const root = await mkdtemp(join(tmpdir(), "deck-t3-usage-flight-"));
  try {
    const { configPath, runtimePath } = await writeConnection(root, usage.origin);
    const reader = new T3UsageReader(() => {}, { configPath, runtimePath });
    usage.state.wsMode = "delayed";
    await Promise.all([reader.refresh(), reader.refresh()]);
    assert.equal(reader.health.state, "ready");
    assert.equal(usage.state.ticketRequests, 1, "a pending poll must not start a second request");
    assert.equal(usage.state.configRequests, 1);
  } finally {
    await usage.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("T3 usage reader yields an empty snapshot for an unavailable provider", {
  skip: process.platform === "win32" ? "T3 usage reader is macOS-only" : false,
}, async () => {
  const usage = await startUsageServer(await loadSample());
  const root = await mkdtemp(join(tmpdir(), "deck-t3-usage-unavail-"));
  try {
    const { configPath, runtimePath } = await writeConnection(root, usage.origin);
    const reader = new T3UsageReader(() => {}, { configPath, runtimePath });
    usage.state.wsMode = "unavailable";
    await reader.refresh();
    assert.equal(reader.health.state, "ready");
    assert.deepEqual(reader.snapshots["t3-codex"], {
      windows: [],
      observedAt: Date.parse("2026-11-13T01:39:13.318Z"),
      resetCreditsAvailable: null,
      resetCreditsApplicable: null,
    });
    assert.equal(reader.snapshots["t3-claude"], undefined);
    assert.equal(reader.snapshots["t3-opencode"], undefined);
  } finally {
    await usage.close();
    await rm(root, { recursive: true, force: true });
  }
});
