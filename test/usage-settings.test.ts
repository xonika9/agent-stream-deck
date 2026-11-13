import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";

type FakeSelect = {
  value: string;
  innerHTML: string;
  listeners: Map<string, (event: { target: FakeSelect }) => void>;
  addEventListener: (type: string, listener: (event: { target: FakeSelect }) => void) => void;
};

function fakeSelect(): FakeSelect {
  const element: FakeSelect = {
    value: "",
    innerHTML: "",
    listeners: new Map(),
    addEventListener: (type, listener) => element.listeners.set(type, listener),
  };
  return element;
}

async function loadInspector(page: string, ids: string[]) {
  const html = await readFile(new URL(`../static/property-inspector/${page}`, import.meta.url), "utf8");
  const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1];
  assert.ok(script, `${page} inspector script`);
  const elements = new Map<string, FakeSelect>();
  for (const id of ids) elements.set(id, fakeSelect());
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
  }
  const window: {
    connectElgatoStreamDeckSocket?: (
      port: number,
      uuid: string,
      registerEvent: string,
      info: unknown,
      actionInfo: string,
    ) => void;
  } = {};
  runInNewContext(script, {
    window,
    WebSocket: FakeWebSocket,
    document: { getElementById: (id: string) => elements.get(id) ?? null },
  });
  const element = (id: string): FakeSelect => elements.get(id)!;
  const connect = (settings: Record<string, unknown> = {}, platform = "mac"): FakeWebSocket => {
    window.connectElgatoStreamDeckSocket?.(
      28196,
      "inspector-context",
      "registerPropertyInspector",
      {
        application: { platform },
      },
      JSON.stringify({ context: "inspector-context", payload: { settings } }),
    );
    const socket = sockets.at(-1);
    assert.ok(socket, "inspector opened a socket");
    socket.open();
    return socket;
  };
  const change = (id: string, value: string): void => {
    element(id).value = value;
    element(id).listeners.get("change")?.({ target: element(id) });
  };
  const settingsSent = (socket: FakeWebSocket): Array<Record<string, unknown>> =>
    socket.sent
      .filter((message) => message.event === "setSettings")
      .map((message) => message.payload as Record<string, unknown>);
  return { html, element, connect, change, settingsSent };
}

test("usage limit keeps legacy mode and offers only the source windows", async () => {
  const { element, connect, settingsSent } = await loadInspector("usage-limit.html", ["source", "mode"]);
  const socket = connect({ mode: "weekly" });
  assert.equal(element("source").value, "codex-auto");
  assert.equal(element("mode").value, "weekly");
  assert.match(element("source").innerHTML, /value="codex-auto"/);
  assert.match(element("source").innerHTML, /value="t3-opencode"/);
  assert.match(element("mode").innerHTML, /value="weekly"/);
  assert.doesNotMatch(element("mode").innerHTML, /weekly-fable/);
  assert.doesNotMatch(element("mode").innerHTML, /monthly/);
  assert.deepEqual(settingsSent(socket), [], "a valid legacy mode is not rewritten");
});

test("usage limit adds Fable when switching to T3 Claude and saves the source", async () => {
  const { element, connect, change, settingsSent } = await loadInspector("usage-limit.html", ["source", "mode"]);
  const socket = connect({ source: "codex-auto", mode: "weekly" });
  change("source", "t3-claude");
  assert.match(element("mode").innerHTML, /value="weekly-fable"/);
  assert.equal(element("mode").value, "weekly", "an offered window is kept");
  assert.deepEqual(settingsSent(socket).at(-1), { source: "t3-claude", mode: "weekly" });
});

test("usage limit resets an unoffered window to Automatic and saves it", async () => {
  const { element, connect, change, settingsSent } = await loadInspector("usage-limit.html", ["source", "mode"]);
  const socket = connect({ source: "t3-claude", mode: "weekly-fable" });
  assert.equal(element("mode").value, "weekly-fable");
  change("source", "t3-codex");
  assert.equal(element("mode").value, "auto");
  assert.deepEqual(settingsSent(socket).at(-1), { source: "t3-codex", mode: "auto" });
});

test("usage limit hides T3 sources on Windows", async () => {
  const { element, connect } = await loadInspector("usage-limit.html", ["source", "mode"]);
  connect({ source: "codex-auto", mode: "weekly" }, "windows");
  assert.doesNotMatch(element("source").innerHTML, /t3-/);
  assert.match(element("source").innerHTML, /value="codex-bar"/);
});

test("usage overview defaults to the two Codex bars without an Automatic option", async () => {
  const { element, connect, settingsSent } = await loadInspector("usage-overview.html", ["source", "top", "bottom"]);
  const socket = connect({});
  assert.equal(element("source").value, "codex-auto");
  assert.equal(element("top").value, "five-hour");
  assert.equal(element("bottom").value, "weekly");
  for (const id of ["top", "bottom"]) {
    assert.doesNotMatch(element(id).innerHTML, /value="auto"/);
    assert.match(element(id).innerHTML, /value="five-hour"/);
    assert.match(element(id).innerHTML, /value="weekly"/);
  }
  assert.deepEqual(settingsSent(socket), [], "defaults are not rewritten");
});

test("usage overview adds Monthly for T3 OpenCode and resets an unoffered top bar", async () => {
  const { element, connect, change, settingsSent } = await loadInspector("usage-overview.html", [
    "source",
    "top",
    "bottom",
  ]);
  const socket = connect({ source: "t3-opencode", topWindow: "monthly", bottomWindow: "weekly" });
  assert.equal(element("top").value, "monthly");
  assert.match(element("top").innerHTML, /value="monthly"/);
  change("source", "t3-claude");
  assert.match(element("top").innerHTML, /value="weekly-fable"/);
  assert.equal(element("top").value, "five-hour", "the unoffered Monthly top resets to 5 hours");
  assert.equal(element("bottom").value, "weekly");
  assert.deepEqual(settingsSent(socket).at(-1), {
    source: "t3-claude",
    topWindow: "five-hour",
    bottomWindow: "weekly",
  });
});

test("usage limit saves the corrected stale window on open", async () => {
  const { connect, settingsSent } = await loadInspector("usage-limit.html", ["source", "mode"]);
  const socket = connect({ source: "t3-codex", mode: "weekly-fable" });
  assert.deepEqual(settingsSent(socket), [{ source: "t3-codex", mode: "auto" }]);
});

test("usage overview saves the corrected stale source on open", async () => {
  const { element, connect, settingsSent } = await loadInspector("usage-overview.html", ["source", "top", "bottom"]);
  const socket = connect({ source: "t3-claude" }, "windows");
  assert.equal(element("source").value, "codex-auto");
  assert.deepEqual(settingsSent(socket), [{ source: "codex-auto", topWindow: "five-hour", bottomWindow: "weekly" }]);
});

test("usage overview hides T3 sources on Windows", async () => {
  const { element, connect } = await loadInspector("usage-overview.html", ["source", "top", "bottom"]);
  connect({}, "windows");
  assert.doesNotMatch(element("source").innerHTML, /t3-/);
});
