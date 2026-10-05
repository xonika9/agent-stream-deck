import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { build } from "esbuild";
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildCodexLaunchSpec,
  buildLaunchAgentPlist,
  buildWatcherLaunchScript,
  parseDebugPort,
} from "../launcher/macos/codex-deck-macos.js";
import { codexDeckStateRoot } from "../src/runtime/paths.js";

test("macOS launcher uses LaunchServices and passes loopback-only CDP arguments", () => {
  const spec = buildCodexLaunchSpec({ appPath: "/Applications/Unexpected Codex Name.app" }, 43123);
  assert.equal(spec.command, "/usr/bin/open");
  assert.deepEqual(spec.args, [
    "-n",
    "-a",
    "/Applications/Unexpected Codex Name.app",
    "--args",
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=43123",
  ]);
  assert.doesNotMatch(spec.args.join(" "), /0\.0\.0\.0/);
});

test("macOS launcher validates ports and parses both supported flag forms", () => {
  assert.throws(() => buildCodexLaunchSpec({ appPath: "/Applications/Codex.app" }, 0), /Invalid debugging port/);
  assert.equal(parseDebugPort("Codex --remote-debugging-port=43123"), 43123);
  assert.equal(parseDebugPort("Codex --remote-debugging-port 43124"), 43124);
  assert.equal(parseDebugPort("Codex --remote-debugging-port=70000"), null);
});

test("bridge and user icon state use the native macOS Application Support root", () => {
  assert.equal(codexDeckStateRoot("darwin", "/Users/tester"), "/Users/tester/Library/Application Support/CodexDeck");
  assert.equal(
    codexDeckStateRoot("win32", "C:\\Users\\tester", "C:\\Users\\tester\\AppData\\Local"),
    "C:\\Users\\tester\\AppData\\Local\\CodexDeck",
  );
});

test("LaunchAgent uses a dynamic Node resolver instead of pinning an NVM version", () => {
  const launcher = buildWatcherLaunchScript("/tmp/Codex Deck/runtime.mjs");
  const plist = buildLaunchAgentPlist("/tmp/Codex Deck/watcher-launch.sh");
  assert.match(launcher, /\.nvm\/versions\/node\/\*\/bin\/node/);
  assert.match(launcher, /Contents\/Resources\/cua_node\/bin\/node/);
  assert.match(launcher, /Node\.js 24 or newer/);
  assert.match(plist, /<string>\/bin\/zsh<\/string>/);
  assert.match(plist, /watcher-launch\.sh/);
  assert.match(plist, /watcher\.stderr\.log/);
  assert.doesNotMatch(plist, /\.nvm\/versions\/node\/v\d/);
});

test("manual and double-click launch resolve Node outside an interactive shell", async () => {
  const source = await import("node:fs/promises").then(({ readFile }) =>
    readFile(new URL("../launcher/start-codex-deck.sh", import.meta.url), "utf8"),
  );
  assert.match(source, /\.nvm\/versions\/node\/\*\/bin\/node/);
  assert.match(source, /Contents\/Resources\/cua_node\/bin\/node/);
  assert.match(source, /node_major/);
  assert.doesNotMatch(source, /exec \/usr\/bin\/env node/);
});

test("macOS release packaging preserves executable launchers", async () => {
  const source = await import("node:fs/promises").then(({ readFile }) =>
    readFile(new URL("../scripts/package-macos-release.sh", import.meta.url), "utf8"),
  );
  assert.match(source, /chmod 755/);
  assert.match(source, /start-codex-deck\.sh/);
  assert.match(source, /Start Codex Deck\.command/);
  assert.match(source, /ditto -c -k/);
});

test("macOS watcher update fails before stopping on preflight failure and reports partial bootstrap failure", {
  skip: process.platform !== "darwin",
}, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "codex-watcher-install-")));
  try {
    const fixtureRuntime = join(root, "runtime.mjs");
    await build({
      entryPoints: [fileURLToPath(new URL("../launcher/macos/codex-deck-macos.ts", import.meta.url))],
      outfile: fixtureRuntime,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node24",
      banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
    });
    const mockPath = join(root, "mock.mjs");
    const callsPath = join(root, "calls.json");
    await writeFile(
      mockPath,
      `
      import childProcess from "node:child_process";
      import { syncBuiltinESMExports } from "node:module";
      import { writeFileSync } from "node:fs";
      import { join } from "node:path";
      let watcher;
      process.on("beforeExit", () => {
        if (!watcher) return;
        const child = watcher;
        watcher = undefined;
        child.once("exit", () => writeFileSync(${JSON.stringify(join(root, "watcher-exited"))}, "exited"));
        child.ref();
        child.kill();
      });
      const original = childProcess.spawnSync;
      const originalSpawn = childProcess.spawn;
      childProcess.spawn = (...args) => {
        if (process.env.CHILD_WATCHER === "true") throw new Error("Fixture blocked external process launch");
        return originalSpawn(...args);
      };
      const calls = [];
      childProcess.spawnSync = (command, args, options) => {
        if (process.env.CHILD_WATCHER === "true") {
          if (command === "/bin/ps") return { status: 0, stdout: "", stderr: "" };
          // Block discovery, app launch/quit, and every external child command.
          return { status: 1, stdout: "", stderr: "Fixture blocked external command" };
        }
        if (command === "/bin/launchctl") {
          calls.push(args);
          writeFileSync(${JSON.stringify(callsPath)}, JSON.stringify(calls));
          if (process.env.INSTALL_SCENARIO === "live") {
            if (args[0] === "bootstrap") watcher = childProcess.spawn("/bin/zsh", [join(process.env.HOME, "Library/Application Support/CodexDeck/watcher-launch.sh")], { env: { ...process.env, CHILD_WATCHER: "true", NODE_OPTIONS: "--import=" + JSON.stringify(${JSON.stringify(mockPath)}) }, stdio: "ignore" });
            watcher?.unref();
            return { status: 0, stdout: args[0] === "print" ? "state = running; pid = " + watcher.pid : "", stderr: "" };
          }
          if (process.env.INSTALL_SCENARIO === "no-ready") return { status: 0, stdout: args[0] === "print" ? "state = running; pid = 777" : "", stderr: "" };
          if (process.env.INSTALL_SCENARIO === "busy") return { status: args[0] === "print" ? 0 : 1, stdout: "state = running", stderr: "fixture busy service" };
          return { status: args[0] === "bootout" ? 0 : 1, stdout: "", stderr: "fixture launchctl failure" };
        }
        if (command === "/bin/zsh" && process.env.PREFLIGHT_FAIL === "true") {
          return { status: 1, stdout: "", stderr: "fixture runtime preflight failure" };
        }
        return original(command, args, options);
      };
      syncBuiltinESMExports();
    `,
    );
    for (const scenario of ["preflight", "bootstrap", "busy", "no-ready", "live"]) {
      const preflightFails = scenario === "preflight";
      await writeFile(callsPath, "[]");
      const result = spawnSync(process.execPath, ["--import", mockPath, fixtureRuntime, "install"], {
        env: { ...process.env, HOME: root, PREFLIGHT_FAIL: String(preflightFails), INSTALL_SCENARIO: scenario },
        encoding: "utf8",
        timeout: 35_000,
      });
      assert.equal(result.status, scenario === "live" ? 0 : 1, result.stderr);
      const calls = JSON.parse(await readFile(callsPath, "utf8")) as string[][];
      if (preflightFails) {
        assert.match(result.stderr, /fixture runtime preflight failure/);
        assert.deepEqual(calls, [], "preflight failure must not stop the existing service");
      } else if (scenario === "busy") {
        assert.match(result.stderr, /runtime was left unchanged/);
        assert.deepEqual(
          calls.map((args) => args[0]),
          ["bootout", "print"],
        );
      } else if (scenario === "no-ready") {
        assert.match(result.stderr, /did not acquire its lock and confirm startup/);
        assert.doesNotMatch(result.stdout, /installed and watcher running/);
        assert.ok(calls.some((args) => args[0] === "bootstrap"));
        assert.ok(calls.some((args) => args[0] === "print"));
      } else if (scenario === "live") {
        assert.match(result.stdout, /installed and watcher running/);
        assert.ok(calls.some((args) => args[0] === "print"));
        assert.equal(await readFile(join(root, "watcher-exited"), "utf8"), "exited");
        await assert.rejects(readFile(join(root, "Library/Application Support/CodexDeck/watcher.lock/pid")));
      } else {
        assert.match(result.stderr, /partially failed after stopping the old service/);
        assert.deepEqual(
          calls.map((args) => args[0]),
          ["bootout", "bootstrap"],
        );
        assert.match(calls[0]![1]!, /com\.simeo\.codex-deck\.watcher$/);
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("double-click launcher handles success, decline and accepted restart in actual zsh", {
  skip: process.platform !== "darwin",
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-command-"));
  try {
    const command = join(root, "Start Codex Deck.command");
    await writeFile(command, await readFile(new URL("../launcher/Start Codex Deck.command", import.meta.url)));
    const stub = join(root, "start-codex-deck.sh");
    await writeFile(
      stub,
      '#!/bin/zsh\n[[ "$2" == "--restart" ]] && { print restarted; exit 0; }\nexit $FIXTURE_STATUS\n',
    );
    await chmod(stub, 0o755);
    for (const scenario of [
      { status: "0", input: "", restarted: false },
      { status: "2", input: "no\n", restarted: false },
      { status: "2", input: "yes\n", restarted: true },
    ]) {
      const result = spawnSync("/bin/zsh", [command], {
        env: { ...process.env, FIXTURE_STATUS: scenario.status },
        input: scenario.input,
        encoding: "utf8",
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout.includes("restarted"), scenario.restarted);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
