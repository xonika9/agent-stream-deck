// Releases use calendar versions YY.M.D.N dated in Europe/Moscow, with a
// positive daily sequence. Stream Deck rejects leading zeros in manifest
// versions, so month and day are not zero-padded and the same string serves
// package.json, the manifest, tags, and artifact names.
const CALENDAR_VERSION = /^([1-9]\d)\.([1-9]\d?)\.([1-9]\d?)\.([1-9]\d*)$/u;

export function parseCalendarVersion(version) {
  const match = CALENDAR_VERSION.exec(version);
  if (!match) throw new Error(`Version ${version} is not a calendar version YY.M.D.N.`);
  const [year, month, day, number] = match.slice(1).map(Number);
  const date = new Date(Date.UTC(2000 + year, month - 1, day));
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new Error(`Version ${version} names a date that does not exist.`);
  }
  return { year, month, day, number };
}

export function isCalendarVersion(version) {
  try {
    parseCalendarVersion(version);
    return true;
  } catch {
    return false;
  }
}

export function moscowDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Moscow",
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(now);
  const value = (type) => Number(parts.find((part) => part.type === type)?.value);
  return { year: value("year"), month: value("month"), day: value("day") };
}

export function nextReleaseVersion(tags, day = moscowDate()) {
  if (day.year < 2010 || day.year > 2099) throw new Error("Two-digit release years cover 2010 through 2099.");
  const today = day.year * 10_000 + day.month * 100 + day.day;
  let highest = 0;
  for (const tag of tags) {
    if (!tag.startsWith("v") || !isCalendarVersion(tag.slice(1))) continue; // Historical SemVer tags stay as they are.
    const released = parseCalendarVersion(tag.slice(1));
    const releasedDay = (2000 + released.year) * 10_000 + released.month * 100 + released.day;
    if (releasedDay > today) throw new Error(`Tag ${tag} is dated after the proposed release day.`);
    if (releasedDay === today) highest = Math.max(highest, released.number);
  }
  return `${day.year - 2000}.${day.month}.${day.day}.${highest + 1}`;
}

// Releases before the calendar scheme used SemVer X.Y.Z (manifest X.Y.Z.0)
// and hotfixes X.Y.Z-hotfix.W (manifest X.Y.Z.W); keep reading them.
export function releaseVersionForPackage(packageVersion) {
  if (isCalendarVersion(packageVersion)) return packageVersion;
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
