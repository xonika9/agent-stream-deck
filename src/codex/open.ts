import { spawn } from "node:child_process";
import { win32 } from "node:path";

const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type CodexOpenSpec = { executable: string; args: string[]; windowsHide: boolean };

export function codexThreadUrl(threadId: string): string {
  if (threadId !== "new" && !THREAD_ID.test(threadId)) throw new Error(`Invalid Codex task ID: ${threadId}`);
  return `codex://threads/${threadId}`;
}

export function codexOpenSpec(
  threadId: string,
  targetPlatform = process.platform,
  systemRoot = process.env.SystemRoot ?? "C:\\Windows"
): CodexOpenSpec {
  const url = codexThreadUrl(threadId);
  if (targetPlatform === "darwin") return { executable: "/usr/bin/open", args: [url], windowsHide: false };
  if (targetPlatform === "win32") {
    const executable = win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    return {
      executable,
      args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", `Start-Process -FilePath '${url}'`],
      windowsHide: true
    };
  }
  throw new Error(`Opening Codex links is unsupported on ${targetPlatform}.`);
}

export function openCodexThread(threadId: string): Promise<void> {
  const spec = codexOpenSpec(threadId);
  return new Promise((resolve, reject) => {
    const child = spawn(spec.executable, spec.args, { windowsHide: spec.windowsHide, stdio: ["ignore", "ignore", "pipe"] });
    let errorOutput = "";
    child.stderr.on("data", (data) => { errorOutput += String(data); });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Codex link could not be opened (${code ?? "unknown"}): ${errorOutput.trim()}`));
    });
  });
}
