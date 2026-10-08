import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const auditScript = join(dirname(fileURLToPath(import.meta.url)), "audit-release.mjs");

async function sha256(path) {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

// Checksums come first so the audit also inspects SHA256SUMS.txt.
export async function finalizeReleaseDirectory(output, options = {}) {
  const artifactNames = (await readdir(output)).filter((name) => name !== "SHA256SUMS.txt").sort();
  const checksums = [];
  for (const name of artifactNames) checksums.push(`${await sha256(join(output, name))}  ${name}`);
  await writeFile(join(output, "SHA256SUMS.txt"), `${checksums.join("\n")}\n`, "utf8");
  execFileSync(process.execPath, [auditScript, output], { stdio: options.stdio ?? "inherit" });
}
