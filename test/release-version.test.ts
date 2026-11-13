import assert from "node:assert/strict";
import test from "node:test";
import {
  assertManifestMatchesPackage,
  isCalendarVersion,
  moscowDate,
  nextReleaseVersion,
} from "../scripts/release-version.mjs";

test("calendar versions are YY.M.D.N without leading zeros on a real date", () => {
  for (const version of ["26.11.13.1", "26.1.5.12", "27.12.31.1"]) assert.ok(isCalendarVersion(version), version);
  for (const version of ["26.11.03.1", "26.01.5.1", "26.11.13.0", "26.11.13.01", "26.2.30.1", "26.13.1.1", "2.2.2"]) {
    assert.equal(isCalendarVersion(version), false, version);
  }
});

test("the next version continues today's daily sequence and ignores historical SemVer tags", () => {
  const day = { year: 2026, month: 11, day: 3 };
  assert.equal(nextReleaseVersion(["v2.2.2", "v2.2.1"], day), "26.11.3.1");
  assert.equal(nextReleaseVersion(["v26.11.3.2", "v26.11.3.10", "v26.11.2.4"], day), "26.11.3.11");
  assert.equal(nextReleaseVersion(["v26.11.3.4"], { year: 2027, month: 1, day: 1 }), "27.1.1.1");
  assert.throws(() => nextReleaseVersion(["v26.11.4.1"], day), /after the proposed release day/u);
});

test("release days follow the Moscow calendar", () => {
  assert.deepEqual(moscowDate(new Date("2026-11-13T21:30:00Z")), { year: 2026, month: 11, day: 14 });
  assert.deepEqual(moscowDate(new Date("2026-11-13T20:59:00Z")), { year: 2026, month: 11, day: 13 });
});

test("the manifest uses the calendar version unchanged and still reads historical SemVer", () => {
  assert.doesNotThrow(() => assertManifestMatchesPackage("26.11.13.1", "26.11.13.1"));
  assert.throws(() => assertManifestMatchesPackage("26.11.13.1", "26.11.13.1.0"), /does not match/u);
  assert.doesNotThrow(() => assertManifestMatchesPackage("2.2.2", "2.2.2.0"));
  assert.doesNotThrow(() => assertManifestMatchesPackage("2.2.2-hotfix.1", "2.2.2.1"));
  assert.throws(() => assertManifestMatchesPackage("2.2.3", "2.2.2.0"), /does not match/u);
});
