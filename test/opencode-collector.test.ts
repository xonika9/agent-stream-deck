import assert from "node:assert/strict";
import test from "node:test";
import {
  OpenCodeCollector,
  type OpenCodeCollectorDependencies,
  type OpenCodeProcess
} from "../src/opencode/collector.js";

const SECRET = "0123456789abcdef0123456789abcdef";
const HOME = "/fixture/home";
const STATE = `${HOME}/.local/state/opencode`;
const SETTINGS = `${HOME}/Library/Application Support/ai.opencode.desktop/opencode.settings`;

type FileEntry = { body: unknown; safe?: boolean };

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(JSON.stringify(value))) }
  });
}

function session(
  id: string,
  updated: number,
  input: { parentID?: string; outcome?: "succeeded" | "failed" | "interrupted"; idle?: number; viewed?: number } = {}
) {
  return {
    id,
    parentID: input.parentID,
    title: `PRIVATE TITLE ${id}`,
    location: { directory: `/private/${id}` },
    cost: 999,
    tokens: { input: 123 },
    outcome: input.outcome,
    time: { created: updated - 100, updated, idle: input.idle, viewed: input.viewed }
  };
}

function fixture(input: {
  files?: Record<string, FileEntry>;
  routes?: Record<string, Response | ((request: { url: string; authorization?: string }) => Response | Promise<Response>)>;
  now?: number;
  processes?: OpenCodeProcess[];
  waitForTunnel?: boolean;
}) {
  const files = input.files ?? {};
  const requests: Array<{ url: string; authorization?: string }> = [];
  const processes = [...(input.processes ?? [])];
  const terminated: number[] = [];
  const spawnCalls: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv; detached: boolean }> = [];
  const dependencies: OpenCodeCollectorDependencies = {
    homeDirectory: HOME,
    stateDirectory: STATE,
    settingsPath: SETTINGS,
    currentUid: 501,
    now: () => input.now ?? 1_000_000,
    setInterval: () => ({}) as NodeJS.Timeout,
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
      const authorization = new Headers(init?.headers).get("authorization") ?? undefined;
      requests.push({ url, authorization });
      const parsed = new URL(url);
      const route = input.routes?.[`${parsed.host}${parsed.pathname}${parsed.search}`]
        ?? input.routes?.[parsed.pathname + parsed.search]
        ?? input.routes?.[parsed.pathname];
      if (!route) throw new Error("unavailable");
      return typeof route === "function" ? route({ url, authorization }) : route.clone();
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
  return { dependencies, requests, terminated, spawnCalls };
}

function localRegistration(extra: Record<string, unknown> = {}) {
  return { id: "managed", url: "http://127.0.0.1:4096", password: "fixture-password", version: "2.0.5", pid: 42, ...extra };
}

function basicRoutes(now = 1_000_000) {
  return {
    "/api/status": ({ authorization }: { authorization?: string }) => authorization
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
});

test("rejects unsafe, non-loopback, broad, and incompatible registrations before fetch", async () => {
  const files: Record<string, FileEntry> = {
    [`${STATE}/service.json`]: { body: localRegistration(), safe: false },
    [`${STATE}/service-bad-url.json`]: { body: localRegistration({ id: "bad-url", url: "http://example.com:4096" }) },
    [`${STATE}/service-bad-version.json`]: { body: localRegistration({ id: "bad-version", version: "2.0.6" }) },
    [`${STATE}/service-bad-pid.json`]: { body: localRegistration({ id: "bad-pid", pid: 0 }) }
  };
  const setup = fixture({ files, routes: basicRoutes() });
  const collector = new OpenCodeCollector({ identitySecret: SECRET, dependencies: setup.dependencies });

  const snapshot = await collector.start();
  await collector.stop();

  assert.deepEqual(snapshot.connections, []);
  assert.equal(setup.requests.length, 0);
});

test("does not send a local service credential before the authentication boundary is proven", async () => {
  const setup = fixture({
    files: { [`${STATE}/service.json`]: { body: localRegistration() } },
    routes: { "/api/status": response({ version: "2.0.5", pid: 42 }) }
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
      "/api/status": ({ authorization }) => authorization ? response({ version: "2.0.5", pid: 42 }) : response({}, 401),
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
    status: "working",
    workStartedAt: now - 2_100,
    workStartRevision: 0
  });
  assert.deepEqual(tasks.map((task) => task.label), ["OpenCode 1", "OpenCode 2", "OpenCode 3", "OpenCode 4"]);
  const serialized = JSON.stringify(snapshot);
  for (const privateValue of ["PRIVATE TITLE", "/private/", "SECRET_RESOURCE", "SECRET_FORM", "cost", "tokens", "location"]) {
    assert.equal(serialized.includes(privateValue), false, privateValue);
  }
});

test("expires terminal outcomes at five minutes and hides outcomes viewed after idle", async () => {
  const now = 3_000_000;
  const routes = basicRoutes(now);
  routes["/api/session?parentID=null&order=desc&limit=100"] = response({
    data: [
      session("ses_kept", now - 299_999, { outcome: "succeeded", idle: now - 299_999 }),
      session("ses_expired", now - 300_000, { outcome: "failed", idle: now - 300_000 }),
      session("ses_viewed", now - 1_000, { outcome: "failed", idle: now - 1_000, viewed: now - 500 })
    ],
    cursor: {}
  });
  const setup = fixture({ now, files: { [`${STATE}/service.json`]: { body: localRegistration() } }, routes });
  const collector = new OpenCodeCollector({ identitySecret: SECRET, dependencies: setup.dependencies });

  const snapshot = await collector.start();
  await collector.stop();

  assert.deepEqual(snapshot.connections[0]!.tasks.map((task) => task.sessionId), ["ses_kept"]);
});

test("keeps a healthy connection visible when another connection fails", async () => {
  const files = {
    [`${STATE}/service-a.json`]: { body: localRegistration({ id: "a", url: "http://127.0.0.1:4101", pid: 101 }) },
    [`${STATE}/service-b.json`]: { body: localRegistration({ id: "b", url: "http://127.0.0.1:4102", pid: 102 }) }
  };
  const ok = basicRoutes();
  ok["/api/status"] = ({ authorization }) => authorization ? response({ version: "2.0.5", pid: 101 }) : response({}, 401);
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
    routes: { ...routes, "/api/status": ({ authorization }) => authorization ? response({ version: "2.0.5", pid: 77 }) : response({}, 401) },
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
  assert.ok(setup.spawnCalls[1]!.args.some((argument) => argument.startsWith("127.0.0.1:43123:")));
  assert.equal(JSON.stringify(setup.spawnCalls).includes("fixture-password"), false);
  assert.equal(Object.keys(setup.spawnCalls[0]!.env).some((key) => /password|token|secret/iu.test(key)), false);
  assert.equal(JSON.stringify(snapshot).includes("test-host"), false);
  assert.equal(JSON.stringify(snapshot).includes("Private name"), false);
});
