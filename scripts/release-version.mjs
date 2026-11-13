export function releaseVersionForPackage(packageVersion) {
  const hotfix = /^(\d+\.\d+\.\d+)-hotfix\.(\d+)$/u.exec(packageVersion);
  if (hotfix) return `${hotfix[1]}.${hotfix[2]}`;
  if (/^\d+\.\d+\.\d+$/u.test(packageVersion)) return packageVersion;
  throw new Error(`Unsupported package release version: ${packageVersion}`);
}

export function manifestVersionForPackage(packageVersion) {
  const releaseVersion = releaseVersionForPackage(packageVersion);
  return releaseVersion.split(".").length === 4 ? releaseVersion : `${releaseVersion}.0`;
}

export function assertManifestMatchesPackage(packageVersion, manifestVersion) {
  const expected = manifestVersionForPackage(packageVersion);
  if (manifestVersion !== expected) {
    throw new Error(
      `Manifest version ${manifestVersion} does not match package ${packageVersion} (expected ${expected}).`,
    );
  }
}
