import type { AgentVisualStatus } from "./types.js";

export function visualStatusFromMicro(status: string): AgentVisualStatus {
  switch (status) {
    case "off":
      return "empty";
    case "working":
    case "thinking":
      return "thinking";
    case "unread":
    case "complete":
    case "completed":
    case "done":
      return "complete";
    case "approval":
    case "attention":
    case "awaiting-approval":
    case "awaiting-response":
      return "input";
    case "error":
      return "error";
    default:
      return "idle";
  }
}
