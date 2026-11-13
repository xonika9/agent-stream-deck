import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ACCEPTANCE_CHECKS, runStageAcceptance } from "../scripts/stage-acceptance.mjs";

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
}

async function initRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "deck-acceptance-"));
  git(dir, "init");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "Test");
  await writeFile(join(dir, "note.txt"), "v1\n", "utf8");
  git(dir, "add", "note.txt");
  git(dir, "commit", "-m", "initial");
  return dir;
}

test("dirty working tree is rejected before any check runs", async () => {
  const repo = await initRepo();
  const output = join(await mkdtemp(join(tmpdir(), "deck-acceptance-out-")), "result.json");
  let calls = 0;
  try {
    await writeFile(join(repo, "note.txt"), "dirty\n", "utf8");
    const { outputPath, report } = await runStageAcceptance({
      repoRoot: repo,
      outputPath: output,
      runCheck: async () => {
        calls += 1;
        return { exitCode: 0 };
      },
    });
    assert.equal(outputPath, output);
    assert.equal(report.result, "rejected");
    assert.match(report.reason ?? "", /dirty/);
    assert.equal(calls, 0);
    assert.ok(report.checks.every((row) => row.status === "skipped" && row.blocking));
    const stored = JSON.parse(await readFile(output, "utf8"));
    assert.deepEqual(stored, report);
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(join(output, ".."), { recursive: true, force: true }).catch(() => {});
  }
});

test("clean tree with passing stubs reports pass with one row per check", async () => {
  const repo = await initRepo();
  const output = join(await mkdtemp(join(tmpdir(), "deck-acceptance-out-")), "result.json");
  try {
    const { report } = await runStageAcceptance({
      repoRoot: repo,
      outputPath: output,
      runCheck: async () => ({ exitCode: 0 }),
    });
    assert.equal(report.revision, git(repo, "rev-parse", "HEAD"));
    assert.equal(report.result, "pass");
    assert.equal(report.checks.length, ACCEPTANCE_CHECKS.length);
    assert.deepEqual(
      ACCEPTANCE_CHECKS.map((check) => check.command),
      [
        ["npm", "ci"],
        ["npm", "run", "lint"],
        ["npm", "run", "check:boundaries"],
        ["npm", "run", "check"],
        ["npm", "test"],
        ["npm", "run", "validate"],
        ["npm", "run", "pack"],
        ["npm", "run", "audit:release"],
      ],
    );
    for (const row of report.checks) {
      assert.equal(row.status, "pass");
      assert.equal(row.blocking, true);
      assert.equal(row.exitCode, 0);
      assert.ok(typeof row.durationMs === "number" && row.durationMs >= 0);
    }
    assert.ok(Date.parse(report.startedAt) <= Date.parse(report.finishedAt));
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(join(output, ".."), { recursive: true, force: true }).catch(() => {});
  }
});

test("a failing stub keeps the other rows and reports fail", async () => {
  const repo = await initRepo();
  const output = join(await mkdtemp(join(tmpdir(), "deck-acceptance-out-")), "result.json");
  try {
    const seen: string[] = [];
    const { report } = await runStageAcceptance({
      repoRoot: repo,
      outputPath: output,
      runCheck: async (check) => {
        seen.push(check.name);
        return { exitCode: check.name === "lint" ? 1 : 0 };
      },
    });
    assert.equal(report.result, "fail");
    assert.equal(report.checks.length, ACCEPTANCE_CHECKS.length);
    assert.deepEqual(
      seen,
      ACCEPTANCE_CHECKS.map((check) => check.name),
    );
    const lint = report.checks.find((row) => row.name === "lint");
    assert.equal(lint?.status, "fail");
    assert.equal(lint?.exitCode, 1);
    assert.ok(report.checks.filter((row) => row.name !== "lint").every((row) => row.status === "pass"));
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(join(output, ".."), { recursive: true, force: true }).catch(() => {});
  }
});

test("an export failure is rejected with skipped rows and no check runs", async () => {
  const repo = await initRepo();
  const output = join(await mkdtemp(join(tmpdir(), "deck-acceptance-out-")), "result.json");
  let calls = 0;
  try {
    const { outputPath, report } = await runStageAcceptance({
      repoRoot: repo,
      outputPath: output,
      exportTree: async () => {
        throw new Error("archive boom");
      },
      runCheck: async () => {
        calls += 1;
        return { exitCode: 0 };
      },
    });
    assert.equal(outputPath, output);
    assert.equal(report.result, "rejected");
    assert.match(report.reason ?? "", /could not export/);
    assert.equal(calls, 0);
    assert.equal(report.checks.length, ACCEPTANCE_CHECKS.length);
    assert.ok(report.checks.every((row) => row.status === "skipped" && row.exitCode === null && row.blocking));
    const stored = JSON.parse(await readFile(output, "utf8"));
    assert.deepEqual(stored, report);
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(join(output, ".."), { recursive: true, force: true }).catch(() => {});
  }
});

test("a throwing check fails with a null exit code and a non-zero exit carries its tail", async () => {
  const repo = await initRepo();
  const output = join(await mkdtemp(join(tmpdir(), "deck-acceptance-out-")), "result.json");
  try {
    const { report } = await runStageAcceptance({
      repoRoot: repo,
      outputPath: output,
      runCheck: async (check) => {
        if (check.name === "test") throw new Error("runner boom");
        if (check.name === "lint") return { exitCode: 1, outputTail: "lint tail" };
        return { exitCode: 0 };
      },
    });
    assert.equal(report.result, "fail");
    assert.equal(report.checks.length, ACCEPTANCE_CHECKS.length);
    const thrown = report.checks.find((row) => row.name === "test");
    assert.equal(thrown?.status, "fail");
    assert.equal(thrown?.exitCode, null);
    assert.ok(!("outputTail" in (thrown ?? {})), "a throwing check has no tail to carry");
    const lint = report.checks.find((row) => row.name === "lint");
    assert.equal(lint?.status, "fail");
    assert.equal(lint?.exitCode, 1);
    assert.equal(lint?.outputTail, "lint tail");
    assert.ok(
      report.checks.filter((row) => row.name !== "test" && row.name !== "lint").every((row) => row.status === "pass"),
    );
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(join(output, ".."), { recursive: true, force: true }).catch(() => {});
  }
});

test("a HEAD change during the run is rejected", async () => {
  const repo = await initRepo();
  const output = join(await mkdtemp(join(tmpdir(), "deck-acceptance-out-")), "result.json");
  try {
    const { report } = await runStageAcceptance({
      repoRoot: repo,
      outputPath: output,
      runCheck: async (check) => {
        if (check.name === ACCEPTANCE_CHECKS[0]?.name) git(repo, "commit", "--allow-empty", "-m", "mid-run");
        return { exitCode: 0 };
      },
    });
    assert.equal(report.result, "rejected");
    assert.match(report.reason ?? "", /changed during the run/);
    assert.equal(report.checks.length, ACCEPTANCE_CHECKS.length);
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(join(output, ".."), { recursive: true, force: true }).catch(() => {});
  }
});
