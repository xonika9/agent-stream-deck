import assert from "node:assert/strict";
import test from "node:test";
import {
  OpenCodeCollector,
  type OpenCodeCollectorDependencies,
  type OpenCodeProcess
} from "#opencode";

const SECRET = "0123456789abcdef0123456789abcdef";
const HOME = "/fixture/home";
const STATE = `${HOME}/.local/state/opencode`;
const SETTINGS = `${HOME}/Library/Application Support/ai.opencode.desktop/opencode.settings`;

type FileEntry = { body: unknown; safe?: boolean };
type CapturedRequest = {
  url: string;
  method: string;
  authorization?: string;
  contentType?: string;
  body?: string;
};
type RouteEntry = Response | ((request: CapturedRequest) => Response | Promise<Response>);

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(JSON.stringify(value))) }
  });
}

function session(
  id: string,
  updated: number,
  input: {
    parentID?: string;
    outcome?: "succeeded" | "failed" | "interrupted";
    idle?: number;
    viewed?: number;
    title?: string;
  } = {}
) {
  return {
    id,
    parentID: input.parentID,
    title: input.title ?? `PRIVATE TITLE ${id}`,
    location: { directory: `/private/${id}` },
    cost: 999,
    tokens: { input: 123 },
    outcome: input.outcome,
    time: { created: updated - 100, updated, idle: input.idle, viewed: input.viewed }
  };
}

function fixture(input: {
  files?: Record<string, FileEntry>;
  routes?: Record<string, RouteEntry>;
  now?: number | (() => number);
  processes?: OpenCodeProcess[];
  waitForTunnel?: boolean;
}) {
  const files = input.files ?? {};
  const requests: CapturedRequest[] = [];
  const processes = [...(input.processes ?? [])];
  const terminated: number[] = [];
  const intervals: number[] = [];
  const spawnCalls: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv; detached: boolean }> = [];
  const dependencies: OpenCodeCollectorDependencies = {
    homeDirectory: HOME,
    stateDirectory: STATE,
    settingsPath: SETTINGS,
    currentUid: 501,
    now: () => typeof input.now === "function" ? input.now() : (input.now ?? 1_000_000),
    setInterval: (_callback, milliseconds) => {
      intervals.push(milliseconds);
      return {} as NodeJS.Timeout;
    },
    clearInterval: () => undefined,
    files: {
      async list(path) {
        if (path !== STATE) return [];
        return Object.keys(files).filter((file) => file.startsWith(`${STATE}/`)).map((file) => file.slice(STATE.length + 1));
      },
      async readSecure(path) {
        const entry = files[path];
        if (!entry) throw new Error("missing");
        if (entry.safe === false) throw new Error("unsafe");
        return Buffer.from(JSON.stringify(entry.body));
      }
    },
    async fetch(url, init) {
      const headers = new Headers(init?.headers);
      const request = {
        url,
        method: init?.method ?? "GET",
        authorization: headers.get("authorization") ?? undefined,
        contentType: headers.get("content-type") ?? undefined,
        body: typeof init?.body === "string" ? init.body : undefined
      };
      requests.push(request);
      const parsed = new URL(url);
      const route = input.routes?.[`${parsed.host}${parsed.pathname}${parsed.search}`]
        ?? input.routes?.[parsed.pathname + parsed.search]
        ?? input.routes?.[parsed.pathname];
      if (!route) throw new Error("unavailable");
      return typeof route === "function" ? route(request) : route.clone();
    },
    async spawn(command, args, options) {
      spawnCalls.push({ command, args: [...args], env: { ...options.env }, detached: options.detached });
      const process = processes.shift();
      if (!process) throw new Error("unexpected spawn");
      return process;
    },
    async reserveLoopbackPort() { return 43123; },
    async waitForLoopbackPort() { return input.waitForTunnel !== false; },
    async terminateProcessGroup(process) { terminated.push(process.pid); process.kill("SIGTERM"); }
  };
  return { dependencies, requests, terminated, spawnCalls, intervals };
}

function localRegistration(extra: Record<string, unknown> = {}) {
  return { id: "managed", url: "http://127.0.0.1:4096", password: "fixture-password", version: "2.0.5", pid: 42, ...extra };
}

function basicRoutes(now = 1_000_000): Record<string, RouteEntry> {
  return {
    "/api/info": ({ authorization }: { authorization?: string }) => authorization
      ? response({ version: "2.0.5", pid: 42 })
      : response({}, 401),
    "/api/session/active": response({ data: {} }),
    "/api/permission/request": response({ data: [] }),
    "/api/form": response({ data: [] }),
    "/api/session?parentID=null&order=desc&limit=100": response({
      data: [session("ses_idle", now - 100)], cursor: {}
    })
  };
}

test("discovers a descriptor-approved local registration without publishing its endpoint or password", async () => {
  const setup = fixture({
    files: { [`${STATE}/service.json`]: { body: localRegistration() } },
    routes: basicRoutes()
  });
  const collector = new OpenCodeCollector({ identitySecret: SECRET, dependencies: setup.dependencies });

  const snapshot = await collector.start();
  await collector.stop();

  assert.equal(snapshot.connections.length, 1);
  assert.equal(snapshot.connections[0]!.health, "ready");
  assert.deepEqual(snapshot.connections[0]!.tasks, []);
  assert.match(snapshot.connections[0]!.connectionId, /^oc_[A-Za-z0-9_-]+$/u);
  assert.equal(JSON.stringify(snapshot).includes("4096"), false);
  assert.equal(JSON.stringify(snapshot).includes("fixture-password"), false);
  assert.ok(setup.requests.every((request) => request.authorization == null || !request.authorization.includes("fixture-password")));
  assert.deepEqual(setup.intervals, [5_000]);
});

test("prefers api info and reuses its authenticated identity route across polls", async () => {
  const routes = basicRoutes();
  routes["/api/status"] = ({ authorization }) => authorization ? response({}, 404) : response({}, 401);
  routes["/api/info"] = ({ authorization }) => authorization
    ? response({ version: "2.0.5", pid: 42, urls: [], paths: {} })
    : response({}, 401);
  const setup = fixture({
    files: { [`${STATE}/service.json`]: { body: localRegistration() } },
    routes
  });
  const collector = new OpenCodeCollector({ identitySecret: SECRET, dependencies: setup.dependencies });

  const snapshot = await collector.start();
  await collector.refresh();
  await collector.stop();

  assert.equal(snapshot.connections[0]!.health, "ready");
  const statusRequests = setup.requests.filter((request) => new URL(request.url).pathname === "/api/status");
  const infoRequests = setup.requests.filter((request) => new URL(request.url).pathname === "/api/info");
  assert.equal(statusRequests.length, 0);
  assert.deepEqual(infoRequests.map((request) => request.authorization === undefined), [true, false, false]);
});

test("falls back to legacy api status and reuses it across polls", async () => {
  const routes = basicRoutes();
  routes["/api/info"] = response({}, 404);
  routes["/api/status"] = ({ authorization }) => authorization
    ? response({ version: "2.0.5", pid: 42 })
    : response({}, 401);
  const setup = fixture({
    files: { [`${STATE}/service.json`]: { body: localRegistration() } },
    routes
  });
  const collector = new OpenCodeCollector({ identitySecret: SECRET, dependencies: setup.dependencies });

  const snapshot = await collector.start();
  await collector.refresh();
  await collector.stop();

  assert.equal(snapshot.connections[0]!.health, "ready");
  const infoRequests = setup.requests.filter((request) => new URL(request.url).pathname === "/api/info");
  const statusRequests = setup.requests.filter((request) => new URL(request.url).pathname === "/api/status");
  assert.equal(infoRequests.length, 1);
  assert.deepEqual(statusRequests.map((request) => request.authorization === undefined), [true, false, false]);
});

test("reprobes the authentication boundary when a local registration changes", async () => {
  const registration = localRegistration();
  let identityPid = registration.pid;
  const routes = basicRoutes();
  routes["/api/info"] = ({ authorization }) => authorization
    ? response({ version: "2.0.5", pid: identityPid })
    : response({}, 401);
  const setup = fixture({
    files: { [`${STATE}/service.json`]: { body: registration } },
    routes
  });
  const collector = new OpenCodeCollector({ identitySecret: SECRET, dependencies: setup.dependencies });

  await collector.start();
  registration.pid = 43;
  identityPid = 43;
  await collector.refresh();
  await collector.stop();

  const infoRequests = setup.requests.filter((request) => new URL(request.url).pathname === "/api/info");
  assert.deepEqual(infoRequests.map((request) => request.authorization === undefined), [true, false, true, false]);
});

test("rejects unsafe, non-loopback, broad, and incompatible registrations before fetch", async () => {
  const files: Record<string, FileEntry> = {
    [`${STATE}/service.json`]: { body: localRegistration(), safe: false },
    [`${STATE}/service-bad-url.json`]: { body: localRegistration({ id: "bad-url", url: "http://example.com:4096" }) },
    [`${STATE}/service-bad-version.json`]: { body: localRegistration({ id: "bad-version", version: "" }) },
    [`${STATE}/service-bad-pid.json`]: { body: localRegistration({ id: "bad-pid", pid: 0 }) }
  };
  const setup = fixture({ files, routes: basicRoutes() });
  const collector = new OpenCodeCollector({ identitySecret: SECRET, dependencies: setup.dependencies });

  const snapshot = await collector.start();
  await collector.stop();

  assert.deepEqual(snapshot.connections, []);
  assert.equal(setup.requests.length, 0);
});

test("accepts a future service version when the authenticated API capabilities still match", async () => {
  const routes = basicRoutes();
  routes["/api/info"] = ({ authorization }) => authorization
    ? response({ version: "2.0.6", pid: 42 })
    : response({}, 401);
  const setup = fixture({
    files: { [`${STATE}/service.json`]: { body: localRegistration({ version: "2.0.6" }) } },
    routes
  });
  const collector = new OpenCodeCollector({ identitySecret: SECRET, dependencies: setup.dependencies });

  const snapshot = await collector.start();
  await collector.stop();

  assert.equal(snapshot.connections[0]!.health, "ready");
});

test("rejects a stale registration when the authenticated service identity does not match", async () => {
  const routes = basicRoutes();
  routes["/api/info"] = ({ authorization }) => authorization
    ? response({ version: "2.0.7", pid: 42 })
    : response({}, 401);
  const setup = fixture({
    files: { [`${STATE}/service.json`]: { body: localRegistration({ version: "2.0.6" }) } },
    routes
  });
  const collector = new OpenCodeCollector({ identitySecret: SECRET, dependencies: setup.dependencies });

  const snapshot = await collector.start();
  await collector.stop();

  assert.equal(snapshot.connections[0]!.health, "incompatible");
});

test("does not send a local service credential before the authentication boundary is proven", async () => {
  const setup = fixture({
    files: { [`${STATE}/service.json`]: { body: localRegistration() } },
    routes: { "/api/info": response({ version: "2.0.5", pid: 42 }) }
  });
  const collector = new OpenCodeCollector({ identitySecret: SECRET, dependencies: setup.dependencies });

  const snapshot = await collector.start();
  await collector.stop();

  assert.equal(snapshot.connections[0]!.health, "incompatible");
  assert.deepEqual(setup.requests.map((request) => request.authorization), [undefined]);
});

test("projects only sanitized roots with attention precedence and mixed active and terminal states", async () => {
  const now = 2_000_000;
  const roots = [
    session("ses_attention", now - 1_000),
    session("ses_working", now - 2_000),
    session("ses_complete", now - 3_000, { outcome: "succeeded", idle: now - 3_000 }),
    session("ses_error", now - 4_000, { outcome: "failed", idle: now - 4_000 }),
    session("ses_idle", now - 5_000),
    session("ses_interrupted", now - 6_000, { outcome: "interrupted", idle: now - 6_000 })
  ];
  const child = session("ses_child", now - 500, { parentID: "ses_attention" });
  const setup = fixture({
    now,
    files: { [`${STATE}/service.json`]: { body: localRegistration() } },
    routes: {
      "/api/info": ({ authorization }) => authorization ? response({ version: "2.0.5", pid: 42 }) : response({}, 401),
      "/api/session/active": response({ data: { ses_working: { type: "running" }, ses_attention: { type: "running" } } }),
      "/api/permission/request": response({ data: [{ id: "per_private", sessionID: "ses_child", resources: ["SECRET_RESOURCE"] }] }),
      "/api/form": response({ data: [{ id: "frm_private", sessionID: "ses_attention", title: "SECRET_FORM", fields: [] }] }),
      "/api/session?parentID=null&order=desc&limit=100": response({ data: roots, cursor: {} }),
      "/api/session/ses_child": response({ data: child })
    }
  });
  const collector = new OpenCodeCollector({ identitySecret: SECRET, dependencies: setup.dependencies });

  const snapshot = await collector.start();
  await collector.stop();
  const tasks = snapshot.connections[0]!.tasks;

  assert.deepEqual(tasks.map((task) => [task.sessionId, task.status]), [
    ["ses_attention", "attention"],
    ["ses_error", "error"],
    ["ses_complete", "complete"],
    ["ses_working", "working"]
  ]);
  assert.deepEqual(tasks.find((task) => task.sessionId === "ses_working"), {
    source: "opencode",
    connectionId: tasks[0]!.connectionId,
    sessionId: "ses_working",
    label: "OpenCode 4",
    displayTitle: "PRIVATE TITLE ses_working",
    status: "working",
    workStartedAt: now - 2_100,
    workStartRevision: 0
  });
  assert.deepEqual(tasks.map((task) => task.displayTitle), [
    "PRIVATE TITLE ses_attention",
    "PRIVATE TITLE ses_error",
    "PRIVATE TITLE ses_complete",
    "PRIVATE TITLE ses_working"
  ]);
  assert.deepEqual(tasks.map((task) => task.label), ["OpenCode 1", "OpenCode 2", "OpenCode 3", "OpenCode 4"]);
  const serialized = JSON.stringify(snapshot);
  for (const privateValue of ["/private/", "SECRET_RESOURCE", "SECRET_FORM", "cost", "tokens", "location"]) {
    assert.equal(serialized.includes(privateValue), false, privateValue);
  }
});

test("bounds and sanitizes titles before local rendering", async () => {
  const routes = basicRoutes();
  routes["/api/session/active"] = response({ data: { ses_title: { type: "running" } } });
  routes["/api/session?parentID=null&order=desc&limit=100"] = response({
    data: [session("ses_title", 999_000, { title: `  Visible\u0000 chat\n${"界".repeat(200)}  ` })],
    cursor: {}
  });
  const setup = fixture({ files: { [`${STATE}/service.json`]: { body: localRegistration() } }, routes });
  const collector = new OpenCodeCollector({ identitySecret: SECRET, dependencies: setup.dependencies });

  const snapshot = await collector.start();
  await collector.stop();
  const title = snapshot.connections[0]!.tasks[0]!.displayTitle;

  assert.ok(title?.startsWith("Visible chat "));
  assert.ok(Buffer.byteLength(title ?? "", "utf8") <= 256);
  assert.doesNotMatch(title ?? "", /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u);
});

test("expires successful and failed terminal outcomes five minutes after their event", async () => {
  let now = 3_000_000;
  const routes = basicRoutes(now);
  routes["/api/session?parentID=null&order=desc&limit=100"] = response({
    data: [
      session("ses_complete", now - 299_999, { outcome: "succeeded", idle: now - 299_999 }),
      session("ses_error", now - 299_999, { outcome: "failed", idle: now - 299_999 }),
      session("ses_old", now - 300_000, { outcome: "failed", idle: now - 300_000 }),
      session("ses_viewed", now - 1_000, { outcome: "failed", idle: now - 1_000, viewed: now - 500 })
    ],
    cursor: {}
  });
  const setup = fixture({ now: () => now, files: { [`${STATE}/service.json`]: { body: localRegistration() } }, routes });
  const collector = new OpenCodeCollector({ identitySecret: SECRET, dependencies: setup.dependencies });

  const first = await collector.start();
  now += 1;
  const later = await collector.refresh();
  await collector.stop();

  assert.deepEqual(first.connections[0]!.tasks.map((task) => task.sessionId), ["ses_error", "ses_complete"]);
  assert.deepEqual(later.connections[0]!.tasks, []);
});

test("acknowledges only the current terminal result and shows a later completion again", async () => {
  const now = 3_000_000;
  let idle = now - 1_000;
  const setup = fixture({
    now,
    files: { [`${STATE}/service.json`]: { body: localRegistration() } },
    routes: {
      ...basicRoutes(now),
      "/api/session?parentID=null&order=desc&limit=100": () => response({
        data: [session("ses_ack", idle, { outcome: "succeeded", idle })],
        cursor: {}
      })
    }
  });
  const collector = new OpenCodeCollector({ identitySecret: SECRET, dependencies: setup.dependencies });

  const first = await collector.start();
  const task = first.connections[0]!.tasks[0]!;
  assert.equal(collector.acknowledgeTask(task.connectionId, task.sessionId, task.terminalAt!), true);
  assert.deepEqual(collector.snapshot().connections[0]!.tasks, []);

  const sameResult = await collector.refresh();
  assert.deepEqual(sameResult.connections[0]!.tasks, []);

  idle += 500;
  const nextResult = await collector.refresh();
  await collector.stop();

  assert.deepEqual(nextResult.connections[0]!.tasks.map((candidate) => candidate.sessionId), ["ses_ack"]);
});

test("publishes the acknowledged terminal revision through the official session view route", async () => {
  const now = 3_000_000;
  const idle = now - 1_000;
  const routes = basicRoutes(now);
  routes["/api/session?parentID=null&order=desc&limit=100"] = response({
    data: [session("ses_ack", idle, { outcome: "succeeded", idle })], cursor: {}
  });
  routes["/api/session/ses_ack/view"] = (request) => {
    assert.equal(request.method, "POST");
    assert.notEqual(request.authorization, undefined);
    assert.equal(request.contentType, "application/json");
    assert.deepEqual(JSON.parse(request.body ?? "null"), { idle });
    return new Response(null, { status: 204 });
  };
  const setup = fixture({
    now,
    files: { [`${STATE}/service.json`]: { body: localRegistration({ version: "2.0.10" }) } },
    routes: {
      ...routes,
      "/api/info": ({ authorization }) => authorization
        ? response({ version: "2.0.10", pid: 42 })
        : response({}, 401)
    }
  });
  const collector = new OpenCodeCollector({ identitySecret: SECRET, dependencies: setup.dependencies });

  const first = await collector.start();
  const task = first.connections[0]!.tasks[0]!;
  assert.equal(collector.acknowledgeTask(task.connectionId, task.sessionId, task.terminalAt!), true);
  assert.equal(await collector.publishTaskViewed(task.connectionId, task.sessionId), true);
  await collector.stop();

  assert.equal(setup.requests.filter((request) => new URL(request.url).pathname.endsWith("/view")).length, 1);
  assert.deepEqual(collector.snapshot().connections[0]!.tasks, []);
});

test("keeps the local acknowledgement when the session view route is unavailable", async () => {
  const now = 3_000_000;
  const idle = now - 1_000;
  const routes = basicRoutes(now);
  routes["/api/session?parentID=null&order=desc&limit=100"] = response({
    data: [session("ses_legacy", idle, { outcome: "failed", idle })], cursor: {}
  });
  routes["/api/session/ses_legacy/view"] = response({}, 404);
  const setup = fixture({
    now,
    files: { [`${STATE}/service.json`]: { body: localRegistration() } },
    routes
  });
  const collector = new OpenCodeCollector({ identitySecret: SECRET, dependencies: setup.dependencies });

  const first = await collector.start();
  const task = first.connections[0]!.tasks[0]!;
  assert.equal(collector.acknowledgeTask(task.connectionId, task.sessionId, task.terminalAt!), true);
  assert.equal(await collector.publishTaskViewed(task.connectionId, task.sessionId), false);
  await collector.stop();

  assert.deepEqual(collector.snapshot().connections[0]!.tasks, []);
});

test("does not publish a synthetic view revision when OpenCode omits the idle timestamp", async () => {
  const now = 3_000_000;
  const updated = now - 1_000;
  const routes = basicRoutes(now);
  routes["/api/session?parentID=null&order=desc&limit=100"] = response({
    data: [session("ses_no_idle", updated, { outcome: "succeeded" })], cursor: {}
  });
  routes["/api/session/ses_no_idle/view"] = new Response(null, { status: 204 });
  const setup = fixture({
    now,
    files: { [`${STATE}/service.json`]: { body: localRegistration({ version: "2.0.10" }) } },
    routes: {
      ...routes,
      "/api/info": ({ authorization }) => authorization
        ? response({ version: "2.0.10", pid: 42 })
        : response({}, 401)
    }
  });
  const collector = new OpenCodeCollector({ identitySecret: SECRET, dependencies: setup.dependencies });

  const first = await collector.start();
  const task = first.connections[0]!.tasks[0]!;
  assert.equal(collector.acknowledgeTask(task.connectionId, task.sessionId, task.terminalAt!), true);
  assert.equal(await collector.publishTaskViewed(task.connectionId, task.sessionId), false);
  await collector.stop();

  assert.equal(setup.requests.some((request) => new URL(request.url).pathname.endsWith("/view")), false);
});

test("does not acknowledge a newer terminal revision through a stale displayed assignment", async () => {
  const now = 3_000_000;
  let idle = now - 1_000;
  const setup = fixture({
    now,
    files: { [`${STATE}/service.json`]: { body: localRegistration() } },
    routes: {
      ...basicRoutes(now),
      "/api/session?parentID=null&order=desc&limit=100": () => response({
        data: [session("ses_race", idle, { outcome: "succeeded", idle })], cursor: {}
      })
    }
  });
  const collector = new OpenCodeCollector({ identitySecret: SECRET, dependencies: setup.dependencies });

  const first = await collector.start();
  const displayed = first.connections[0]!.tasks[0]!;
  idle += 500;
  const refreshed = await collector.refresh();
  const current = refreshed.connections[0]!.tasks[0]!;

  assert.notEqual(displayed.terminalAt, current.terminalAt);
  assert.equal(collector.acknowledgeTask(displayed.connectionId, displayed.sessionId, displayed.terminalAt!), false);
  assert.deepEqual(collector.snapshot().connections[0]!.tasks.map((task) => task.terminalAt), [current.terminalAt]);
  await collector.stop();
});

test("keeps a healthy connection visible when another connection fails", async () => {
  const files = {
    [`${STATE}/service-a.json`]: { body: localRegistration({ id: "a", url: "http://127.0.0.1:4101", pid: 101 }) },
    [`${STATE}/service-b.json`]: { body: localRegistration({ id: "b", url: "http://127.0.0.1:4102", pid: 102 }) }
  };
  const ok = basicRoutes();
  ok["/api/info"] = ({ authorization }) => authorization ? response({ version: "2.0.5", pid: 101 }) : response({}, 401);
  ok["/api/session?parentID=null&order=desc&limit=100"] = response({
    data: [session("ses_ok", 999_000, { outcome: "succeeded", idle: 999_000 })], cursor: {}
  });
  const routes = Object.fromEntries(Object.entries(ok).map(([path, value]) => [`127.0.0.1:4101${path}`, value]));
  const setup = fixture({ files, routes });
  const collector = new OpenCodeCollector({ identitySecret: SECRET, dependencies: setup.dependencies });

  const snapshot = await collector.start();
  await collector.stop();

  assert.equal(snapshot.connections.length, 2);
  assert.equal(snapshot.connections.filter((connection) => connection.health === "ready").length, 1);
  assert.equal(snapshot.connections.filter((connection) => connection.health === "unavailable").length, 1);
  assert.deepEqual(snapshot.connections.flatMap((connection) => connection.tasks).map((task) => task.sessionId), ["ses_ok"]);
});

test("marks a bounded root page incomplete when OpenCode reports more history", async () => {
  const routes = basicRoutes();
  routes["/api/session?parentID=null&order=desc&limit=100"] = response({
    data: [session("ses_page", 999_000, { outcome: "succeeded", idle: 999_000 })],
    cursor: { next: "opaque-page" }
  });
  const setup = fixture({
    files: { [`${STATE}/service.json`]: { body: localRegistration() } },
    routes
  });
  const collector = new OpenCodeCollector({ identitySecret: SECRET, dependencies: setup.dependencies });

  const snapshot = await collector.start();
  await collector.stop();

  assert.equal(snapshot.connections[0]!.complete, false);
  assert.equal(snapshot.connections[0]!.health, "capacity-exceeded");
  assert.deepEqual(snapshot.connections[0]!.tasks.map((task) => task.sessionId), ["ses_page"]);
});

test("keeps a content-free task alias stable across a missed refresh", async () => {
  let visible = true;
  const now = 1_000_000;
  const setup = fixture({
    now,
    files: { [`${STATE}/service.json`]: { body: localRegistration() } },
    routes: {
      ...basicRoutes(now),
      "/api/session?parentID=null&order=desc&limit=100": () => response({
        data: visible ? [session("ses_alias", now - 1_000, { outcome: "succeeded", idle: now - 1_000 })] : [],
        cursor: {}
      })
    }
  });
  const collector = new OpenCodeCollector({ identitySecret: SECRET, dependencies: setup.dependencies });

  const first = await collector.start();
  visible = false;
  await collector.refresh();
  visible = true;
  const restored = await collector.refresh();
  await collector.stop();

  assert.equal(restored.connections[0]!.tasks[0]!.label, first.connections[0]!.tasks[0]!.label);
});

test("discovers a CLI-managed SSH service through bounded pair output", async () => {
  const remoteUrl = "http://127.0.0.1:4096";
  const remotePassword = "private-pair-password";
  let discoveryInput = "";
  const discovery: OpenCodeProcess = {
    pid: 7101,
    stdout: [
      `OPENCODE_SERVICE_STATUS=${remoteUrl}`,
      "OPENCODE_PAIR_BEGIN",
      `\u001b[36m  Password  ${remotePassword}\u001b[0m`,
      "OPENCODE_PAIR_END",
      "OPENCODE_PAIR_STATUS_BEGIN",
      JSON.stringify({ version: "2.0.6", pid: 88 }),
      "OPENCODE_PAIR_STATUS_END",
      ""
    ].join("\n"),
    stderr: "",
    exited: Promise.resolve(0),
    write(data) { discoveryInput += String(data); },
    end() {},
    kill() {}
  };
  const tunnel: OpenCodeProcess = {
    pid: 7102,
    stdout: "",
    stderr: "",
    exited: new Promise(() => undefined),
    write() {},
    end() {},
    kill() {}
  };
  const routes = basicRoutes();
  routes["/api/status"] = ({ authorization }) => authorization ? response({}, 404) : response({}, 401);
  routes["/api/info"] = ({ authorization }) => authorization
    ? response({ version: "2.0.6", pid: 88 })
    : response({}, 401);
  const setup = fixture({
    files: { [SETTINGS]: { body: { "ssh.servers": [{ id: "fedora", target: "test-host", name: "Fedora" }] } } },
    routes,
    processes: [discovery, tunnel]
  });
  const collector = new OpenCodeCollector({ identitySecret: SECRET, dependencies: setup.dependencies });

  const snapshot = await collector.start();
  await collector.stop();

  assert.equal(snapshot.connections[0]!.health, "ready");
  assert.equal(JSON.stringify(snapshot).includes(remotePassword), false);
  assert.equal(JSON.stringify(setup.spawnCalls).includes(remotePassword), false);
  assert.match(discoveryInput, /"\$\{XDG_STATE_HOME:-\$HOME\/\.local\/state\}"/u);
  assert.doesNotMatch(discoveryInput, /\\\$\{/u);
  assert.match(discoveryInput, /\/api\/info/u);
});

test("stop tears down every SSH process group", async () => {
  let tunnelKilled = false;
  const discovery: OpenCodeProcess = {
    pid: 7001,
    stdout: `OPENCODE_SERVICE_STATUS=http://0.0.0.0:4096\nOPENCODE_REGISTRATION_BEGIN\n${JSON.stringify(localRegistration({ url: "http://0.0.0.0:4096", pid: 77 }))}\nOPENCODE_REGISTRATION_END\n`,
    stderr: "",
    exited: Promise.resolve(0),
    write() {},
    end() {},
    kill() {}
  };
  const tunnel: OpenCodeProcess = {
    pid: 7002,
    stdout: "",
    stderr: "",
    exited: new Promise(() => undefined),
    write() {},
    end() {},
    kill() { tunnelKilled = true; }
  };
  const settings = { "ssh.servers": [{ id: "desktop-id", target: "test-host", name: "Private name" }] };
  const routes = basicRoutes();
  const setup = fixture({
    files: { [SETTINGS]: { body: settings } },
    routes: { ...routes, "/api/info": ({ authorization }) => authorization ? response({ version: "2.0.5", pid: 77 }) : response({}, 401) },
    processes: [discovery, tunnel]
  });
  const collector = new OpenCodeCollector({ identitySecret: SECRET, dependencies: setup.dependencies });

  const snapshot = await collector.start();
  await collector.stop();

  assert.equal(tunnelKilled, true);
  assert.deepEqual(setup.terminated, [7002]);
  assert.equal(setup.spawnCalls.length, 2);
  assert.deepEqual(setup.spawnCalls.map((call) => call.command), ["/usr/bin/ssh", "/usr/bin/ssh"]);
  assert.ok(setup.spawnCalls[0]!.args.includes("BatchMode=yes"));
  assert.ok(setup.spawnCalls[1]!.args.includes("ExitOnForwardFailure=yes"));
  assert.equal(setup.spawnCalls[1]!.args.includes("ClearAllForwardings=yes"), false);
  assert.ok(setup.spawnCalls[1]!.args.some((argument) => argument.startsWith("127.0.0.1:43123:")));
  assert.equal(JSON.stringify(setup.spawnCalls).includes("fixture-password"), false);
  assert.equal(Object.keys(setup.spawnCalls[0]!.env).some((key) => /password|token|secret/iu.test(key)), false);
  assert.equal(JSON.stringify(snapshot).includes("test-host"), false);
  assert.equal(JSON.stringify(snapshot).includes("Private name"), false);
});


function sshProcesses(discoveryPid: number, tunnelPid: number, servicePid = 77): OpenCodeProcess[] {
  return [
    { pid: discoveryPid, stdout: `OPENCODE_SERVICE_STATUS=http://0.0.0.0:4096\nOPENCODE_REGISTRATION_BEGIN\n${JSON.stringify(localRegistration({ url: "http://0.0.0.0:4096", pid: servicePid }))}\nOPENCODE_REGISTRATION_END\n`, stderr: "", exited: Promise.resolve(0), write() {}, end() {}, kill() {} },
    { pid: tunnelPid, stdout: "", stderr: "", exited: new Promise(() => undefined), write() {}, end() {}, kill() {} }
  ];
}

test("SSH identity replacement evicts its tunnel and rediscovers without interrupting the local source", async () => {
  let pid = 77;
  const routes = basicRoutes();
  routes["127.0.0.1:43123/api/info"] = ({ authorization }) => authorization ? response({ version: "2.0.5", pid }) : response({}, 401);
  const setup = fixture({ files: { [SETTINGS]: { body: { "ssh.servers": [{ id: "saved", target: "fixture-host", name: "Fixture" }] } }, [`${STATE}/service.json`]: { body: localRegistration() } }, routes, processes: [...sshProcesses(8001, 8002), ...sshProcesses(8003, 8004, 78)] });
  const collector = new OpenCodeCollector({ identitySecret: SECRET, dependencies: setup.dependencies });
  try {
    assert.ok((await collector.start()).connections.every(item => item.health === "ready"));
    pid = 78;
    const incompatible = await collector.refresh();
    assert.deepEqual(incompatible.connections.map(item => item.health).sort(), ["incompatible", "ready"]);
    assert.deepEqual(setup.terminated, [8002]);
    const recovered = await collector.refresh();
    assert.ok(recovered.connections.every(item => item.health === "ready"));
    assert.equal(setup.spawnCalls.length, 4);
  } finally { await collector.stop(); }
});

test("authoritative SSH settings replace changed targets and remove only their own tunnels", async () => {
  const files: Record<string, FileEntry> = { [SETTINGS]: { body: { "ssh.servers": [{ id: "saved", target: "fixture-one", name: "Fixture" }, { id: "retained", target: "fixture-retained", name: "Retained" }] } } };
  const routes = basicRoutes();
  routes["/api/info"] = ({ authorization }) => authorization ? response({ version: "2.0.5", pid: 77 }) : response({}, 401);
  const setup = fixture({ files, routes, processes: [sshProcesses(8101, 8102)[0]!, sshProcesses(8111, 8112)[0]!, sshProcesses(8101, 8102)[1]!, sshProcesses(8111, 8112)[1]!, ...sshProcesses(8103, 8104)] });
  const collector = new OpenCodeCollector({ identitySecret: SECRET, dependencies: setup.dependencies });
  try {
    await collector.start();
    files[SETTINGS]!.safe = false;
    await collector.refresh();
    assert.deepEqual(setup.terminated, [], "unreadable settings cannot prove removal");
    files[SETTINGS] = { body: { "ssh.servers": [{ id: "saved", target: "fixture-two", name: "Fixture" }, { id: "retained", target: "fixture-retained", name: "Retained" }] } };
    await collector.refresh();
    assert.deepEqual(setup.terminated, [8102]);
    assert.ok(setup.spawnCalls[4]!.args.includes("fixture-two"));
    files[SETTINGS] = { body: { "ssh.servers": [{ id: "retained", target: "fixture-retained", name: "Retained" }] } };
    const retained = await collector.refresh();
    assert.equal(retained.connections.length, 1);
    assert.equal(retained.connections[0]!.health, "ready");
    assert.equal(setup.spawnCalls.length, 6);
    assert.deepEqual(setup.terminated, [8102, 8104]);
  } finally { await collector.stop(); }
});

test("stop discards a late authenticated snapshot and never starts its polling interval", async () => {
  let arrived!: () => void;
  const arrival = new Promise<void>(resolve => { arrived = resolve; });
  let finish!: () => void;
  const delayed = new Promise<void>(resolve => { finish = resolve; });
  const routes = basicRoutes();
  routes["/api/session/active"] = async () => {
    arrived();
    await delayed;
    return response({ data: { ses_late: { type: "running" } } });
  };
  routes["/api/session/ses_late"] = response({ data: session("ses_late", 999_900) });
  const setup = fixture({ files: { [`${STATE}/service.json`]: { body: localRegistration() } }, routes });
  const collector = new OpenCodeCollector({ identitySecret: SECRET, dependencies: setup.dependencies });
  const started = collector.start();
  await arrival;
  const stopped = collector.stop();
  finish();
  await Promise.all([started, stopped]);
  assert.deepEqual(collector.snapshot(), { version: 1, observedAt: 0, connections: [] });
  assert.deepEqual(setup.intervals, []);
});
