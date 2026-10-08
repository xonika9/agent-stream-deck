import type { CodexHost, MicroSnapshot } from "#agents";

export const host: CodexHost = {
  hostId: "56fd97ad-7073-42cc-85ce-befa17546d7c",
  hostName: "Test Mac",
  platform: "darwin",
};

/** A fresh six-slot native snapshot per call; slot 0 is working and selected, the rest are idle. */
export function createMicroSnapshot(): MicroSnapshot {
  return {
    slots: Array.from({ length: 6 }, (_, id) => ({
      id,
      threadKey: `00000000-0000-4000-8000-00000000000${id}`,
      title: `Task ${id + 1}`,
      status: id === 0 ? "working" : "idle",
      selected: id === 0,
      activityAt: 1_000 - id,
    })),
    layout: {
      version: 1,
      slots: {
        ACT06: { keycapId: "FAST" },
        ACT07: { keycapId: "APPR" },
        ACT08: { keycapId: "REJ" },
        ACT09: { keycapId: "SPLIT" },
        ACT10_ACT11: { keycapId: "CODEX" },
        ACT12: { keycapId: "CODEX" },
      },
      analogStick: { up: {}, right: {}, down: {}, left: {} },
    },
    agentSource: "recent",
    lightingAutoOff: "3-minutes",
    theme: "dark",
  };
}
