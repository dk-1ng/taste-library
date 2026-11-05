import { type Issue, type Severity, makeIssue } from "./issue.js";

/** The report of format-spec §16.3. Pure. */

export const REPORT_VERSION = 1;

export interface Report {
  reportVersion: typeof REPORT_VERSION;
  /** The version in `library.json`, or `null` when it cannot be read. */
  libraryFormatVersion: number | null;
  supportedFormatVersion: number;
  counts: Record<Severity, number>;
  issues: Issue[];
}

/** Code-unit order, the same on every computer, unlike `localeCompare`. */
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** `null` sorts before any text. */
function compareNullable(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  return compareText(a, b);
}

/** By `file` (`null` first), then `pointer` (`null` first), then `code`; the message settles the rest, so the order never depends on how the issues were found. */
export function compareIssues(a: Issue, b: Issue): number {
  return (
    compareNullable(a.file, b.file) ||
    compareNullable(a.pointer, b.pointer) ||
    compareText(a.code, b.code) ||
    compareText(a.message, b.message)
  );
}

export function sortIssues(issues: readonly Issue[]): Issue[] {
  return [...issues].sort(compareIssues);
}

export function countIssues(issues: readonly Issue[]): Record<Severity, number> {
  const counts: Record<Severity, number> = { error: 0, warning: 0, info: 0 };
  for (const issue of issues) counts[issue.severity]++;
  return counts;
}

/** The `media-not-checked` issue: no media folder is set on this computer (format-spec §6.3). */
export function mediaNotChecked(): Issue {
  return makeIssue(
    "media-not-checked",
    null,
    null,
    "No media folder is set on this computer, so media files were not checked.",
  );
}

/** Builds the report; the issues are sorted here, and the key order is the one of the `--json` output. */
export function buildReport(input: {
  libraryFormatVersion: number | null;
  supportedFormatVersion: number;
  issues: readonly Issue[];
}): Report {
  const issues = sortIssues(input.issues);
  return {
    reportVersion: REPORT_VERSION,
    libraryFormatVersion: input.libraryFormatVersion,
    supportedFormatVersion: input.supportedFormatVersion,
    counts: countIssues(issues),
    issues,
  };
}
