import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { finalizeReleaseDirectory } from "../scripts/finalize-release.mjs";

async function text(path: string): Promise<string> {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

test("current project docs preserve inspiration credit and independent implementation wording", async () => {
  const readme = await text("README.md");
  assert.match(readme, /Shikhar \(@xikhar\)/);
  assert.match(readme, /https:\/\/x\.com\/xikhar/);
  assert.match(readme, /independent implementation/i);
});

test("release finalization writes LF checksums for every artifact before auditing the directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-deck-finalize-"));
  try {
    await writeFile(join(root, "b-release-notes.txt"), "plugin\n", "utf8");
    await writeFile(join(root, "a-install-guide.txt"), "launcher\n", "utf8");
    await finalizeReleaseDirectory(root, { stdio: "pipe" });
    const sha = (value: string) => createHash("sha256").update(value).digest("hex");
    assert.equal(
      await readFile(join(root, "SHA256SUMS.txt"), "utf8"),
      `${sha("launcher\n")}  a-install-guide.txt\n${sha("plugin\n")}  b-release-notes.txt\n`,
    );

    await writeFile(join(root, "watcher-state.json"), "{}\n", "utf8");
    await rm(join(root, "SHA256SUMS.txt"));
    await assert.rejects(finalizeReleaseDirectory(root, { stdio: "pipe" }), (error: { stderr?: Buffer }) =>
      /watcher-state\.json: private runtime state must not be packaged/.test(String(error.stderr)),
    );
    assert.match(
      await readFile(join(root, "SHA256SUMS.txt"), "utf8"),
      /watcher-state\.json\n$/,
      "checksums precede the audit",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("release preparation keeps its npm entry point, Windows npm shim, and platform packagers", async () => {
  const [packageJson, source] = await Promise.all([
    text("package.json").then(JSON.parse),
    text("scripts/prepare-release.mjs"),
  ]);
  assert.equal(packageJson.scripts["release:prepare"], "node scripts/prepare-release.mjs");
  // Windows cannot execFile npm without its .cmd shim.
  assert.ok(source.includes('"npm.cmd"'));
  for (const packager of ["package-windows-release.ps1", "package-macos-release.sh"]) {
    assert.ok(source.includes(`"${packager}"`), `${packager} is referenced`);
    await access(new URL(`../scripts/${packager}`, import.meta.url));
  }
});

test("npm and Stream Deck release versions use their required compatible forms", async () => {
  const [packageJson, manifest] = await Promise.all([
    text("package.json").then(JSON.parse),
    text("static/manifest.json").then(JSON.parse),
  ]);
  const hotfix = /^(\d+\.\d+\.\d+)-hotfix\.(\d+)$/u.exec(packageJson.version);
  const expectedManifest = hotfix ? `${hotfix[1]}.${hotfix[2]}` : `${packageJson.version}.0`;
  assert.equal(manifest.Version, expectedManifest);
});

test("release skill verifies relative checksum entries from the artifact directory", async () => {
  const checks = await text(".claude/skills/release/references/checks.md");
  assert.match(checks, /\(cd outputs\/release-vX\.Y\.Z && shasum -a 256 -c SHA256SUMS\.txt\)/);
});
