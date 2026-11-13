export type CalendarVersion = { year: number; month: number; day: number; number: number };
export type CalendarDay = { year: number; month: number; day: number };
export function parseCalendarVersion(version: string): CalendarVersion;
export function isCalendarVersion(version: string): boolean;
export function moscowDate(now?: Date): CalendarDay;
export function nextReleaseVersion(tags: readonly string[], day?: CalendarDay): string;
export function releaseVersionForPackage(packageVersion: string): string;
export function manifestVersionForPackage(packageVersion: string): string;
export function assertManifestMatchesPackage(packageVersion: string, manifestVersion: unknown): void;
