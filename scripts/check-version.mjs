import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertManifestMatchesPackage } from "./release-version.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const manifest = JSON.parse(await readFile(join(root, "static", "manifest.json"), "utf8"));
assertManifestMatchesPackage(packageJson.version, manifest.Version);
console.log(`Version ${packageJson.version} matches manifest ${manifest.Version}.`);
