import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { renderAgentSvg, renderRateLimitResetKey, renderUsageLimitKey, renderUsageOverviewKey } from "#stream-deck";
import type { ThemeMode, UsageWindow } from "#agents";

function renderPreview(theme: ThemeMode): string {
  const agents = [
    renderAgentSvg(0, "Ready Task", "idle", true, 3, theme),
    renderAgentSvg(1, "Building UI", "thinking", false, 4, theme),
    renderAgentSvg(2, "Needs Review", "input", false, 3, theme),
    renderAgentSvg(3, "Release Ready", "complete", false, 3, theme),
    renderAgentSvg(4, "Test Failed", "error", false, 3, theme),
    renderAgentSvg(5, "Not assigned", "empty", false, 3, theme)
  ];
  const key = 144;
  const gap = 14;
  const padding = 24;
  const width = padding * 2 + agents.length * key + (agents.length - 1) * gap;
  const height = padding * 2 + key;
  const background = theme === "dark" ? "#202224" : "#090B0E";
  const images = agents.map((svg, index) =>
    `<image x="${padding + index * (key + gap)}" y="${padding}" width="${key}" height="${key}" href="data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}"/>`
  ).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" rx="24" fill="${background}"/>${images}</svg>`;
}

function svgFromDataUrl(value: string): string {
  return decodeURIComponent(value.replace(/^data:image\/svg\+xml;charset=utf8,/, ""));
}

function renderUsagePreview(): string {
  const fiveHour: UsageWindow = {
    id: "five-hour", kind: "five-hour", usedPercent: 26, remainingPercent: 74,
    windowDurationMins: 300, resetsAt: null
  };
  const weekly: UsageWindow = {
    id: "weekly", kind: "weekly", usedPercent: 88, remainingPercent: 12,
    windowDurationMins: 10_080, resetsAt: null
  };
  const cards = [
    { label: "5-hour limit", svg: svgFromDataUrl(renderUsageLimitKey(fiveHour, "five-hour")) },
    { label: "Weekly limit", svg: svgFromDataUrl(renderUsageLimitKey(weekly, "weekly")) },
    { label: "Both windows", svg: svgFromDataUrl(renderUsageOverviewKey([fiveHour, weekly])) },
    { label: "2 resets", svg: svgFromDataUrl(renderRateLimitResetKey(2)) },
    { label: "No resets", svg: svgFromDataUrl(renderRateLimitResetKey(0)) }
  ];
  const key = 144;
  const gap = 22;
  const padding = 28;
  const labelHeight = 34;
  const width = padding * 2 + cards.length * key + (cards.length - 1) * gap;
  const height = padding * 2 + key + labelHeight;
  const images = cards.map((card, index) => {
    const x = padding + index * (key + gap);
    const href = `data:image/svg+xml;base64,${Buffer.from(card.svg).toString("base64")}`;
    return `<image x="${x}" y="${padding}" width="${key}" height="${key}" href="${href}"/><text x="${x + key / 2}" y="${padding + key + 25}" text-anchor="middle" fill="#B9BEC3" font-family="-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif" font-size="13" font-weight="600">${card.label}</text>`;
  }).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" rx="24" fill="#202224"/>${images}</svg>`;
}

const directory = resolve("docs/assets");
await mkdir(directory, { recursive: true });
await Promise.all([
  writeFile(resolve(directory, "agent-status-preview.svg"), renderPreview("light"), "utf8"),
  writeFile(resolve(directory, "agent-status-preview-dark.svg"), renderPreview("dark"), "utf8"),
  writeFile(resolve(directory, "usage-controls-preview.svg"), renderUsagePreview(), "utf8")
]);
