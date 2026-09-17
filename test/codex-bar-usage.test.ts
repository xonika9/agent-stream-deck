import assert from "node:assert/strict";
import test from "node:test";
import { CODEX_BAR_FRESH_MS, parseCodexBarUsage } from "../src/codex-bar-usage.js";

const NOW = Date.parse("2026-09-17T20:00:00Z");

test("projects only bounded Codex quota windows", () => {
  const usage = parseCodexBarUsage({
    generatedAt: "2026-09-17T20:00:00Z",
    entries: [{
      provider: "codex",
      updatedAt: "2026-09-17T19:59:00Z",
      creditsRemaining: 123,
      tokenUsage: { sessionTokens: 999 },
      dailyUsage: [{ costUSD: 99 }],
      usageRows: [
        { id: "session", title: "5 hours", percentLeft: 75, window: {
          usedPercent: 99, windowMinutes: 300, resetsAt: "2026-09-17T22:00:00Z", resetDescription: "private copy"
        } },
        { id: "weekly", title: "Weekly", percentLeft: 40, window: {
          usedPercent: 60, windowMinutes: 10080, resetsAt: "2026-09-21T20:00:00Z"
        } }
      ]
    }]
  }, NOW);

  assert.deepEqual(usage, {
    observedAt: Date.parse("2026-09-17T19:59:00Z"),
    resetCreditsAvailable: null,
    resetCreditsApplicable: null,
    windows: [
      { id: "session", kind: "five-hour", usedPercent: 25, remainingPercent: 75,
        windowDurationMins: 300, resetsAt: Date.parse("2026-09-17T22:00:00Z") },
      { id: "weekly", kind: "weekly", usedPercent: 60, remainingPercent: 40,
        windowDurationMins: 10080, resetsAt: Date.parse("2026-09-21T20:00:00Z") }
    ]
  });
  assert.doesNotMatch(JSON.stringify(usage), /private copy|sessionTokens|costUSD|creditsRemaining/u);
});

test("uses primary and secondary when rows are absent", () => {
  const usage = parseCodexBarUsage({ entries: [{
    provider: { id: "codex" },
    updatedAt: NOW,
    primary: { usedPercent: 10, windowMinutes: 300 },
    secondary: { usedPercent: 20, windowMinutes: 10080 }
  }] }, NOW);
  assert.deepEqual(usage?.windows.map((window) => window.kind), ["five-hour", "weekly"]);
});

test("rejects stale, future, malformed, and non-Codex entries", () => {
  assert.equal(parseCodexBarUsage({ entries: [{ provider: "codex", updatedAt: NOW - CODEX_BAR_FRESH_MS - 1,
    usageRows: [{ percentLeft: 50 }] }] }, NOW), undefined);
  assert.equal(parseCodexBarUsage({ entries: [{ provider: "codex", updatedAt: NOW + 60_001,
    usageRows: [{ percentLeft: 50 }] }] }, NOW), undefined);
  assert.equal(parseCodexBarUsage({ entries: [{ provider: "claude", updatedAt: NOW,
    usageRows: [{ percentLeft: 50 }] }] }, NOW), undefined);
  assert.equal(parseCodexBarUsage({ entries: "wrong" }, NOW), undefined);
});
