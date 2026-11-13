import { execFile, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const ACCEPTANCE_CHECKS = [
  { name: "install", command: ["npm", "ci"] },
  { name: "lint", command: ["npm", "run", "lint"] },
  { name: "check:boundaries", command: ["npm", "run", "check:boundaries"] },
  { name: "check", command: ["npm", "run", "check"] },
  { name: "check:version", command: ["npm", "run", "check:version"] },
  { name: "test", command: ["npm", "test"] },
  { name: "validate", command: ["npm", "run", "validate"] },
  { name: "pack", command: ["npm", "run", "pack"] },
  { name: "audit:release", command: ["npm", "run", "audit:release"] },
];

function defaultRepoRoot() {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

async function gitHead(repoRoot) {
  const { stdout } = await execFileAsync("git", ["-C", repoRoot, "rev-parse", "HEAD"]);
  return stdout.trim();
}

async function gitStatus(repoRoot) {
  const { stdout } = await execFileAsync("git", ["-C", repoRoot, "status", "--porcelain"]);
  return stdout;
}

async function defaultExportTree({ repoRoot, destDir, revision }) {
  const archive = spawnSync("git", ["-C", repoRoot, "archive", revision], {
    encoding: "buffer",
    maxBuffer: 512 * 1024 * 1024,
  });
  if (archive.status !== 0) throw new Error(`git archive failed: ${String(archive.stderr ?? "")}`);
  const extract = spawnSync("tar", ["-x", "-C", destDir], { input: archive.stdout });
  if (extract.status !== 0) throw new Error(`tar extract failed: ${String(extract.stderr ?? "")}`);
}

// Full suites and release builds print far more than execFile's default 1 MiB buffer.
const CHECK_OUTPUT_BUFFER = 256 * 1024 * 1024;
const OUTPUT_TAIL_CHARS = 4000;

async function defaultRunCheck(check, { cwd }) {
  try {
    await execFileAsync(check.command[0], check.command.slice(1), { cwd, maxBuffer: CHECK_OUTPUT_BUFFER });
    return { exitCode: 0 };
  } catch (error) {
    const output = `${error.stdout ?? ""}${error.stderr ?? ""}`;
    return { exitCode: typeof error.code === "number" ? error.code : 1, outputTail: output.slice(-OUTPUT_TAIL_CHARS) };
  }
}

function skippedRows(checks) {
  return checks.map((check) => ({
    name: check.name,
    command: [...check.command],
    blocking: true,
    status: "skipped",
    exitCode: null,
    durationMs: 0,
  }));
}

export async function runStageAcceptance(options = {}) {
  const repoRoot = options.repoRoot ?? defaultRepoRoot();
  const checks = options.checks ?? ACCEPTANCE_CHECKS;
  const runCheck = options.runCheck ?? defaultRunCheck;
  const exportTree = options.exportTree ?? defaultExportTree;
  const startedAt = new Date().toISOString();
  const revision = await gitHead(repoRoot);
  const startStatus = await gitStatus(repoRoot);
  const outputPath = options.outputPath ?? join(await mkdtemp(join(tmpdir(), "stage-acceptance-")), "acceptance.json");

  async function writeReport(report) {
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    return { outputPath, report };
  }

  if (startStatus.trim() !== "") {
    return writeReport({
      revision,
      startedAt,
      finishedAt: new Date().toISOString(),
      checks: skippedRows(checks),
      result: "rejected",
      reason: "working tree is dirty",
    });
  }

  const workDir = await mkdtemp(join(tmpdir(), "stage-acceptance-tree-"));
  try {
    try {
      await exportTree({ repoRoot, destDir: workDir, revision });
    } catch (error) {
      return writeReport({
        revision,
        startedAt,
        finishedAt: new Date().toISOString(),
        checks: skippedRows(checks),
        result: "rejected",
        reason: `could not export HEAD tree: ${String(error)}`,
      });
    }
    const rows = [];
    for (const check of checks) {
      const start = Date.now();
      let exitCode = null;
      let status = "fail";
      let outputTail;
      try {
        const outcome = await runCheck(check, { cwd: workDir });
        exitCode = outcome?.exitCode ?? 1;
        status = exitCode === 0 ? "pass" : "fail";
        outputTail = outcome?.outputTail;
      } catch {
        exitCode = null;
        status = "fail";
      }
      rows.push({
        name: check.name,
        command: [...check.command],
        blocking: true,
        status,
        exitCode,
        durationMs: Date.now() - start,
        ...(outputTail ? { outputTail } : {}),
      });
    }
    const finishedAt = new Date().toISOString();
    if ((await gitHead(repoRoot)) !== revision || (await gitStatus(repoRoot)).trim() !== "") {
      return writeReport({
        revision,
        startedAt,
        finishedAt,
        checks: rows,
        result: "rejected",
        reason: "repository changed during the run",
      });
    }
    const failed = rows.some((row) => row.status !== "pass");
    return writeReport({ revision, startedAt, finishedAt, checks: rows, result: failed ? "fail" : "pass" });
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

const invokedAsScript = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedAsScript) {
  const outputOption = process.argv[2] ? { outputPath: resolve(process.argv[2]) } : {};
  const { outputPath, report } = await runStageAcceptance(outputOption);
  console.log(outputPath);
  if (report.result !== "pass") process.exitCode = 1;
}
