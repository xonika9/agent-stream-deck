import type { StdioOptions } from "node:child_process";

export function finalizeReleaseDirectory(output: string, options?: { stdio?: StdioOptions }): Promise<void>;
