import type { OpenCodeFileAccess } from "./secure-files.js";

export type OpenCodeTaskStatus = "attention" | "error" | "complete" | "working";

export type OpenCodeTask = {
  source: "opencode";
  connectionId: string;
  sessionId: string;
  label: string;
  /** Bounded title for this process's local Stream Deck renderer only. */
  displayTitle?: string;
  status: OpenCodeTaskStatus;
  workStartedAt?: number;
  workStartRevision?: number;
  terminalAt?: number;
  viewedAt?: number;
};

export type OpenCodeConnectionHealth = "ready" | "unavailable" | "incompatible" | "capacity-exceeded";

export type OpenCodeConnectionSnapshot = {
  connectionId: string;
  health: OpenCodeConnectionHealth;
  complete: boolean;
  observedAt: number;
  tasks: OpenCodeTask[];
};

export type OpenCodeCollectorSnapshot = {
  version: 1;
  observedAt: number;
  connections: OpenCodeConnectionSnapshot[];
};

export interface OpenCodeProcess {
  pid: number;
  stdout: string | AsyncIterable<Uint8Array | string>;
  stderr: string | AsyncIterable<Uint8Array | string>;
  exited: Promise<number | null>;
  write(data: string | Uint8Array): void;
  end(): void;
  kill(signal: NodeJS.Signals): void;
}

export interface OpenCodeCollectorDependencies {
  homeDirectory: string;
  stateDirectory: string;
  settingsPath: string;
  currentUid?: number;
  now(): number;
  setInterval(callback: () => void, milliseconds: number): NodeJS.Timeout;
  clearInterval(timer: NodeJS.Timeout): void;
  files: OpenCodeFileAccess;
  fetch(url: string, init?: RequestInit): Promise<Response>;
  spawn(
    command: string,
    args: string[],
    options: { env: NodeJS.ProcessEnv; detached: boolean },
  ): Promise<OpenCodeProcess>;
  reserveLoopbackPort(): Promise<number>;
  waitForLoopbackPort(port: number, timeoutMs: number): Promise<boolean>;
  terminateProcessGroup(process: OpenCodeProcess): Promise<void>;
}

export type Registration = { id?: string; url: string; password: string; version: string; pid: number };
export type SshServer = { id: string; target: string; name: string };
export type Connection = {
  connectionId: string;
  endpoint: string;
  password: string;
  version: string;
  pid: number;
  sshTarget?: string;
  identityPath?: string;
  tunnel?: OpenCodeProcess;
};
export type RawSession = {
  id: string;
  parentID?: string;
  displayTitle?: string;
  outcome?: "succeeded" | "failed" | "interrupted";
  time: { created: number; updated: number; idle?: number; viewed?: number };
};
export type TerminalBinding = {
  sourceAt: number;
  idleAt?: number;
  localAt: number;
  lastSeenAt: number;
  acknowledged: boolean;
};
export type LabelBinding = { ordinal: number; lastSeenAt: number };
