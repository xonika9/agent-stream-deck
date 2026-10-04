import { isIP } from "node:net";

export function isAllowedRelayHost(value: string): boolean {
  const host = value.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (["127.0.0.1", "localhost", "::1"].includes(host) || host.endsWith(".ts.net")) return true;
  if (isIP(host) === 4) {
    const [first, second] = host.split(".").map(Number);
    return first === 100 && second != null && second >= 64 && second <= 127;
  }
  return isIP(host) === 6 && host.startsWith("fd7a:115c:a1e0:");
}
