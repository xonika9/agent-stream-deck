import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { renderImportedKeycap } from "#stream-deck";

const iconRoot = process.env.CODEX_DECK_ICON_DIR ?? join(
  process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"),
  "CodexDeck",
  "icons"
);
const files = (await readdir(iconRoot)).filter((name) => name.toLowerCase().endsWith(".svg")).sort();
if (files.length === 0) throw new Error(`No SVG files found in ${iconRoot}`);

const keys = await Promise.all(files.map(async (name) => {
  const source = await readFile(join(iconRoot, name), "utf8");
  const dataUrl = renderImportedKeycap(source, "dark");
  return decodeURIComponent(dataUrl.replace(/^data:image\/svg\+xml;charset=utf8,/, ""));
}));

const columns = 6;
const rows = Math.ceil(keys.length / columns);
const key = 144;
const gap = 14;
const padding = 24;
const width = padding * 2 + columns * key + (columns - 1) * gap;
const height = padding * 2 + rows * key + (rows - 1) * gap;
const images = keys.map((svg, index) =>
  `<image x="${padding + (index % columns) * (key + gap)}" y="${padding + Math.floor(index / columns) * (key + gap)}" width="${key}" height="${key}" href="data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}"/>`
).join("");
const preview = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" rx="24" fill="#202224"/>${images}</svg>`;

const output = resolve("outputs/dark-icon-grid.svg");
await mkdir(resolve("outputs"), { recursive: true });
await writeFile(output, preview, "utf8");
process.stdout.write(`${JSON.stringify({ iconRoot, count: files.length, output }, null, 2)}\n`);
