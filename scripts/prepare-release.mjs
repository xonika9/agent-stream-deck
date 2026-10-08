import { execFileSync } from "node:child_process";
import { copyFile, mkdir, readFile, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { finalizeReleaseDirectory } from "./finalize-release.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputsRoot = join(root, "outputs");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

function run(command, args, options = {}) {
  execFileSync(command, args, { cwd: root, stdio: "inherit", ...options });
}

function parseArguments(argv) {
  const options = { version: process.env.CODEX_DECK_RELEASE_VERSION?.trim() || null, macArchive: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--version" || argument === "--mac-archive") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`Missing value for ${argument}.`);
      if (argument === "--version") options.version = value.trim();
      else options.macArchive = resolve(value);
      index += 1;
      continue;
    }
    throw new Error(`Unknown release option: ${argument}`);
  }
  return options;
}

function releaseVersionForPackage(packageVersion) {
  const hotfix = /^(\d+\.\d+\.\d+)-hotfix\.(\d+)$/u.exec(packageVersion);
  if (hotfix) return `${hotfix[1]}.${hotfix[2]}`;
  if (/^\d+\.\d+\.\d+$/u.test(packageVersion)) return packageVersion;
  throw new Error(`Unsupported package release version: ${packageVersion}`);
}

function manifestVersionForPackage(packageVersion) {
  const releaseVersion = releaseVersionForPackage(packageVersion);
  return releaseVersion.split(".").length === 4 ? releaseVersion : `${releaseVersion}.0`;
}

function assertReleaseVersion(version) {
  if (!/^\d+\.\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z.-]+)?$/u.test(version)) {
    throw new Error(`Invalid release version: ${version}`);
  }
}

function packageWindowsLauncher(outputPath) {
  const source = join(root, "release", "codex-deck-launcher");
  if (process.platform === "win32") {
    run("powershell", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      join(root, "scripts", "package-windows-release.ps1"),
      "-SourcePath",
      source,
      "-OutputPath",
      outputPath,
    ]);
    return;
  }
  run("zip", ["-q", "-r", "-X", outputPath, basename(source)], { cwd: dirname(source) });
}

async function packageMacLauncher(outputPath, suppliedArchive) {
  if (suppliedArchive) {
    await copyFile(suppliedArchive, outputPath);
    return true;
  }
  if (process.platform !== "darwin") return false;
  run("zsh", [join(root, "scripts", "package-macos-release.sh"), outputPath]);
  return true;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const manifest = JSON.parse(await readFile(join(root, "static", "manifest.json"), "utf8"));
  const expectedReleaseVersion = releaseVersionForPackage(packageJson.version);
  const expectedManifestVersion = manifestVersionForPackage(packageJson.version);
  const version = options.version || expectedReleaseVersion;
  assertReleaseVersion(version);
  if (version !== expectedReleaseVersion || manifest.Version !== expectedManifestVersion) {
    throw new Error(
      `Release version mismatch: requested=${version}, package=${packageJson.version}, manifest=${manifest.Version}, expected manifest=${expectedManifestVersion}.`,
    );
  }

  run(npm, ["run", "lint"]);
  run(npm, ["run", "check:boundaries"]);
  run(npm, ["run", "check"]);
  run(npm, ["test"]);
  run(npm, ["run", "validate"]);
  run(npm, ["run", "pack"]);

  const output = join(outputsRoot, `release-v${version}`);
  if (dirname(output) !== outputsRoot) throw new Error("Release output escaped the outputs directory.");
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });

  const pluginName = `${manifest.UUID}.streamDeckPlugin`;
  await copyFile(join(root, pluginName), join(output, pluginName));

  const windowsArchive = join(output, `codex-deck-launcher-windows-v${version}.zip`);
  packageWindowsLauncher(windowsArchive);

  const macArchive = join(output, `codex-deck-launcher-macos-v${version}.zip`);
  const macIncluded = await packageMacLauncher(macArchive, options.macArchive);
  if (!macIncluded) {
    console.warn(
      "macOS ZIP omitted. Create it on macOS with scripts/package-macos-release.sh, then rerun with --mac-archive.",
    );
  }

  await finalizeReleaseDirectory(output);
  console.log(`Release candidate prepared at: ${output}`);
}

await main();
