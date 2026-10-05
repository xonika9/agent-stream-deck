import { basename } from "node:path";
import { applyRuntimeOverride } from "#codex";

if (process.argv[1] && ["runtime-override.mjs", "runtime-override.ts"].includes(basename(process.argv[1]))) {
  const port = Number.parseInt(process.argv[2] ?? "", 10);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("Usage: node runtime-override.mjs <port>");
  const result = await applyRuntimeOverride(port);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
