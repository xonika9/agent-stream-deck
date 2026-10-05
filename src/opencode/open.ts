import { execFile } from "node:child_process";

type ExecFile = (file: string, args: readonly string[]) => Promise<void>;

const runExecFile: ExecFile = (file, args) => new Promise((resolve, reject) => {
  execFile(file, [...args], { windowsHide: true, timeout: 5_000 }, (error) => error ? reject(error) : resolve());
});

export async function foregroundOpenCode(
  platform = process.platform,
  run: ExecFile = runExecFile
): Promise<void> {
  if (platform !== "darwin") throw new Error("OpenCode activation is supported only on the characterized Mac setup.");
  await run("/usr/bin/open", ["-b", "ai.opencode.desktop"]);
}
