export interface AcceptanceCheck {
  name: string;
  command: string[];
}

export interface AcceptanceCheckContext {
  cwd: string;
}

export interface AcceptanceCheckOutcome {
  exitCode: number;
  outputTail?: string;
}

export interface AcceptanceRow {
  name: string;
  command: string[];
  blocking: boolean;
  status: "pass" | "fail" | "skipped";
  exitCode: number | null;
  durationMs: number;
  outputTail?: string;
}

export interface AcceptanceReport {
  revision: string;
  startedAt: string;
  finishedAt: string;
  checks: AcceptanceRow[];
  result: "pass" | "fail" | "rejected";
  reason?: string;
}

export const ACCEPTANCE_CHECKS: AcceptanceCheck[];

export function runStageAcceptance(options?: {
  repoRoot?: string;
  outputPath?: string;
  checks?: AcceptanceCheck[];
  runCheck?: (check: AcceptanceCheck, context: AcceptanceCheckContext) => Promise<AcceptanceCheckOutcome>;
  exportTree?: (args: { repoRoot: string; destDir: string; revision: string }) => Promise<void>;
}): Promise<{ outputPath: string; report: AcceptanceReport }>;
