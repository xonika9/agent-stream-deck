import type { CodexHost, HostHealth, HostSnapshot } from "#agents";
import { getOrCreateHostIdentity } from "../runtime/host-identity.js";
import { CodexMicroRendererBridge, localBridgeFailureReason } from "./bridge.js";

export class CodexSource {
  readonly microBridge: CodexMicroRendererBridge;
  localHost?: CodexHost;
  localSnapshot?: HostSnapshot;
  localHealth: HostHealth = { state: "connecting", reason: "awaiting-snapshot", changedAt: Date.now() };
  private lastError = "";

  constructor(
    log: (message: string) => void,
    private readonly warn: (message: string) => void = log,
  ) {
    this.microBridge = new CodexMicroRendererBridge(log);
  }

  async start(): Promise<void> {
    this.localHost = await getOrCreateHostIdentity();
  }

  async refresh(): Promise<void> {
    try {
      const snapshot = await this.microBridge.refresh();
      this.localHost = await getOrCreateHostIdentity();
      this.localSnapshot = { host: this.localHost, snapshot, observedAt: Date.now() };
      this.localHealth = { state: "ready", changedAt: Date.now() };
      this.lastError = "";
    } catch (error) {
      this.localHealth = { state: "degraded", reason: localBridgeFailureReason(error), changedAt: Date.now() };
      const message = String(error);
      if (message !== this.lastError) {
        this.lastError = message;
        this.warn(`Codex Micro bridge unavailable: ${message}`);
      }
    }
  }

  stop(): void {
    this.microBridge.close();
  }
}
