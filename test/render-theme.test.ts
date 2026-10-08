import assert from "node:assert/strict";
import test from "node:test";
import {
  renderAgentBlackKey,
  renderAgentBlackSvg,
  renderAgentKey,
  renderAgentSvg,
  renderBuiltinKeycap,
  renderFallbackKeycap,
  renderHostTargetKey,
  renderImportedKeycap,
} from "#stream-deck";

test("healthy empty queue positions use a dedicated solid-black data URI", () => {
  const svg = renderAgentBlackSvg();
  assert.equal(
    svg,
    '<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144"><rect width="144" height="144" fill="#000000"/></svg>',
  );
  assert.equal(decodeURIComponent(renderAgentBlackKey().replace(/^data:image\/svg\+xml;charset=utf8,/, "")), svg);
  assert.doesNotMatch(svg, /text|stroke|data-agent|animate|context|host|status/i);
});

test("dark agent tiles use Codex-like charcoal surfaces without pure black", () => {
  const svg = renderAgentSvg(0, "Building dark mode", "thinking", true, 4, "dark");
  assert.match(svg, /data-theme="dark"/);
  assert.match(svg, /#343638/);
  assert.match(svg, /#222426/);
  assert.match(svg, /#F2F2EF/);
  assert.match(svg, /#1683FF/i);
  assert.doesNotMatch(svg, /#000(?:000)?\b/i);
});

test("light and dark agent themes use their own keycap surfaces and title colors", () => {
  const light = renderAgentSvg(0, "Ready", "idle", false, 0, "light");
  const dark = renderAgentSvg(0, "Ready", "idle", false, 0, "dark");
  assert.match(light, /data-theme="light"/);
  assert.deepEqual(keycapStops(light), ["#FFFFFF", "#F0F3F4", "#D6DBDE"]);
  assert.deepEqual(titleFills(light), ["#171C20"]);
  assert.match(dark, /data-theme="dark"/);
  assert.deepEqual(keycapStops(dark), ["#343638", "#2A2C2E", "#222426"]);
  assert.deepEqual(titleFills(dark), ["#F2F2EF"]);
});

test("agent context ring is bounded and can be hidden globally", () => {
  const visible = renderAgentSvg(0, "Context test", "thinking", false, 0, "dark", "M", "ready", 84, true);
  assert.match(visible, /data-context-used="84"/);
  assert.match(visible, /cx="116" cy="25"/);
  assert.match(visible, /data-agent-host="M"><rect x="86" y="16"/);
  assert.match(visible, /#FF9A3D/i);

  const hidden = renderAgentSvg(0, "Context test", "thinking", false, 0, "dark", "M", "ready", 84, false);
  assert.doesNotMatch(hidden, /data-context-used=/);

  const pending = renderAgentSvg(0, "New task", "idle", false, 0, "dark", "M", "ready", undefined, true);
  assert.match(pending, /data-context-used="unknown"/);

  const empty = renderAgentSvg(0, "Not assigned", "empty", false, 0, "dark", "M", "ready", undefined, true);
  assert.doesNotMatch(empty, /data-context-used=/);
});

test("agent titles are enlarged and all state indicators occupy the upper-left slot", () => {
  const complete = renderAgentSvg(0, "Review changes", "complete", false, 0, "dark", undefined, "ready", 42, true);
  assert.match(complete, /font-size="26\.00"/);
  assert.match(complete, /data-agent-motion="complete"[\s\S]*cx="25" cy="25" r="11"/);
  assert.match(complete, /data-context-used="42"[\s\S]*cx="116" cy="25"/);

  const idle = renderAgentSvg(0, "Ready", "idle", false, 0, "dark");
  assert.match(idle, /font-size="27\.00"/);
  assert.match(idle, /data-agent-motion="idle" cx="25" cy="25" r="6" fill="#FFFFFF"/);

  const working = renderAgentSvg(0, "Building UI", "thinking", false, 4, "dark");
  assert.match(working, /data-agent-motion="working"[\s\S]*x="13" y="19"/);
  assert.match(working, /fill="#FFFFFF" fill-opacity="\.98"/);

  const lightWorking = renderAgentSvg(0, "Building UI", "thinking", false, 4, "light");
  assert.match(lightWorking, /data-agent-motion="working"[\s\S]*fill="#15202A" fill-opacity="\.98"/);

  const nextWorking = renderAgentSvg(1, "Building API", "thinking", false, 4, "dark");
  assert.match(working, /data-agent-motion="working"[\s\S]*<rect x="19\.80" y="21"/);
  assert.match(nextWorking, /data-agent-motion="working"[\s\S]*<rect x="28\.20" y="21"/);

  const input = renderAgentSvg(0, "Needs review", "input", false, 0, "dark");
  assert.match(input, /data-agent-motion="input"[\s\S]*x="19" y="17"/);

  const error = renderAgentSvg(0, "Test failed", "error", false, 0, "dark");
  assert.match(error, /data-agent-motion="error"[\s\S]*cx="25" cy="25" r="11"/);

  const empty = renderAgentSvg(0, "Not assigned", "empty", false, 0, "dark");
  assert.match(empty, /data-agent-motion="empty" x="18" y="23"/);
});

test("long agent titles can use three centered lines", () => {
  const longTitle = renderAgentSvg(0, "Investigate yellow triangle", "thinking", false, 0, "dark");
  assert.match(longTitle, /y="62"[\s\S]*>Investigate<\/text>/);
  assert.match(longTitle, /y="91"[\s\S]*>yellow<\/text>/);
  assert.match(longTitle, /y="120"[\s\S]*>triangle<\/text>/);
  assert.match(longTitle, /font-size="24\.00"/);
});

test("agent titles wrap before reaching the horizontal key edges", () => {
  const title = renderAgentSvg(0, "Building UI", "thinking", false, 0, "dark");
  assert.match(title, /x="72" y="73"[\s\S]*>Building<\/text>/);
  assert.match(title, /x="72" y="107"[\s\S]*>UI<\/text>/);
  assert.doesNotMatch(title, />Building UI<\/text>/);
});

test("agent title wrapping preserves Unicode code points", () => {
  assert.doesNotThrow(() => renderAgentKey(0, "123456789😀abc", "thinking", false, 0, "dark"));
  const svg = renderAgentSvg(0, "123456789😀abc", "thinking", false, 0, "dark");
  assert.match(svg, />123456789😀<\/text>/);
  assert.match(svg, />abc<\/text>/);
});

test("user-local monochrome SVGs normalize to an off-white dark glyph", () => {
  const input =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M2 2h20v20H2z" stroke="#000"/></svg>';
  const output = decodeURIComponent(
    renderImportedKeycap(input, "dark").replace(/^data:image\/svg\+xml;charset=utf8,/, ""),
  );
  assert.match(output, /data-theme="dark"/);
  assert.match(output, /fill="#F2F2EE"/);
  assert.match(output, /stroke="#F2F2EE"/);
  assert.match(output, /translate\(18\.000 18\.000\) scale\(4\.50000\)/);
  assert.doesNotMatch(output, /#000(?:000)?\b/i);
});

test("original navigation icons use the same dark keycap system", () => {
  for (const icon of ["back", "forward", "sidebar", "home", "navigation"] as const) {
    const output = decodeURIComponent(
      renderBuiltinKeycap(icon, "dark").replace(/^data:image\/svg\+xml;charset=utf8,/, ""),
    );
    assert.match(output, /data-theme="dark"/);
    assert.match(output, /data-icon-source="codex-deck-original"/);
    assert.match(output, /stroke="#F2F2EE"/);
    assert.doesNotMatch(output, /#000(?:000)?\b/i);
  }
});

test("rendered agent titles keep at least 7:1 contrast against every keycap surface stop", () => {
  for (const theme of ["light", "dark"] as const) {
    const svg = renderAgentSvg(0, "Ready", "idle", false, 0, theme);
    const [title] = titleFills(svg);
    const stops = keycapStops(svg);
    assert.ok(title, `${theme} title fill`);
    assert.equal(stops.length, 3, `${theme} keycap gradient`);
    for (const stop of stops) {
      const ratio = contrast(title, stop);
      assert.ok(ratio >= 7, `${theme} title ${title} on ${stop} has contrast ${ratio.toFixed(2)}`);
    }
  }
});

test("missing local assets receive a readable themed fallback", () => {
  const output = decodeURIComponent(
    renderFallbackKeycap("TERM", "dark").replace(/^data:image\/svg\+xml;charset=utf8,/, ""),
  );
  assert.match(output, /data-icon-source="fallback-label"/);
  assert.match(output, /font-size="34"/);
  assert.match(output, /font-weight="700"/);
  assert.match(output, />TERM<\/text>/);
  assert.doesNotMatch(output, /#000(?:000)?\b/i);
});

test("host target and affected agent keys expose degraded and offline state", () => {
  const target = decodeURIComponent(
    renderHostTargetKey("MAC", "degraded", "dark").replace(/^data:image\/svg\+xml;charset=utf8,/, ""),
  );
  assert.match(target, /data-host-health="degraded"/);
  assert.match(target, />DEGRADED<\/text>/);
  assert.match(target, /#FF9A3D/i);

  const degradedAgent = renderAgentSvg(0, "Last known task", "idle", false, 0, "dark", "M", "degraded");
  assert.match(degradedAgent, /data-agent-host="M"/);
  assert.match(degradedAgent, /data-agent-host-health="degraded"/);
  assert.doesNotMatch(degradedAgent, /data-agent-motion=/);
  assert.doesNotMatch(degradedAgent, /data-context-used=/);
  const offlineAgent = renderAgentSvg(0, "Last known task", "idle", false, 0, "dark", "M", "offline");
  assert.match(offlineAgent, /data-agent-host-health="offline"/);
  assert.doesNotMatch(offlineAgent, /data-agent-motion=/);
});

function keycapStops(svg: string): string[] {
  const gradient = svg.match(/<linearGradient id="keycap"[^>]*>([\s\S]*?)<\/linearGradient>/)?.[1] ?? "";
  return [...gradient.matchAll(/stop-color="(#[0-9A-F]{6})"/gi)].map((match) => match[1]!);
}

function titleFills(svg: string): string[] {
  return [...svg.matchAll(/<text\b[^>]*\bfill="(#[0-9A-F]{6})"/gi)].map((match) => match[1]!);
}

function contrast(foreground: string, background: string): number {
  const [lighter, darker] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (lighter! + 0.05) / (darker! + 0.05);
}

function luminance(hex: string): number {
  const channels = hex
    .match(/[0-9a-f]{2}/gi)!
    .map((value) => Number.parseInt(value, 16) / 255)
    .map((value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
}
