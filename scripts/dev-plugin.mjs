import { watch } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { relative, resolve } from "node:path";

const PLUGIN_UUID = "com.xonika9.codex-deck";
const WATCH_ROOTS = ["src", "static"];
const GENERATED_FILES = new Set(["static/imgs/plugin-icon.png", "static/imgs/plugin-icon@2x.png"]);
const streamDeckCli = resolve("node_modules", ".bin", process.platform === "win32" ? "streamdeck.cmd" : "streamdeck");

let building = false;
let queued = false;
let debounce;

export function normalizeWatchEventPath(root, filename, cwd = process.cwd()) {
  const normalizedFilename = filename ? String(filename).replaceAll("\\", "/") : "";
  return relative(cwd, resolve(cwd, root, normalizedFilename)).replaceAll("\\", "/");
}

export function shouldRebuildWatchEvent(root, filename, cwd = process.cwd()) {
  return !GENERATED_FILES.has(normalizeWatchEventPath(root, filename, cwd));
}

function run(command, args) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    child.once("error", rejectRun);
    child.once("exit", (code, signal) => {
      if (code === 0) resolveRun();
      else rejectRun(new Error(`${command} exited with ${signal ?? code}`));
    });
  });
}

async function rebuild(reason) {
  if (building) {
    queued = true;
    return;
  }
  building = true;
  console.log(`\n[dev] Rebuilding plugin (${reason})...`);
  try {
    await run(process.execPath, [resolve("scripts/build.mjs")]);
    await run(streamDeckCli, ["restart", PLUGIN_UUID]);
    console.log("[dev] Plugin rebuilt and restarted. Watching for changes...");
  } catch (error) {
    console.error(`[dev] ${String(error)}`);
  } finally {
    building = false;
    if (queued) {
      queued = false;
      void rebuild("changes received during the previous build");
    }
  }
}

function scheduleRebuild(filename) {
  clearTimeout(debounce);
  debounce = setTimeout(() => {
    void rebuild(filename || "file change");
  }, 200);
}

const watchers = [];

function stop() {
  clearTimeout(debounce);
  for (const watcher of watchers) watcher.close();
  console.log("\n[dev] Watcher stopped.");
  process.exit(0);
}

async function main() {
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  await rebuild("initial build");
  for (const root of WATCH_ROOTS) {
    watchers.push(
      watch(root, { recursive: true }, (_event, filename) => {
        if (!shouldRebuildWatchEvent(root, filename)) return;
        scheduleRebuild(normalizeWatchEventPath(root, filename));
      }),
    );
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
