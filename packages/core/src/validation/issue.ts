/** Validation issues in the exact shape of format-spec §16.3. Pure: no Node imports. */

export type Severity = "error" | "warning" | "info";

/** Every code of format-spec §16.2 with its severity. */
export const ISSUE_SEVERITY = {
  "unreadable-file": "error",
  "file-too-large": "error",
  "invalid-encoding": "error",
  "invalid-json": "error",
  "duplicate-key": "error",
  "newer-format": "error",
  "schema-violation": "error",
  "name-mismatch": "error",
  "duplicate-id": "error",
  "broken-local-link": "error",
  "media-folder-mismatch": "error",
  "media-outside-folder": "error",
  "not-canonical": "warning",
  "mixed-format-versions": "warning",
  "dangling-link": "warning",
  "proposal-stale": "warning",
  "duplicate-term": "warning",
  "media-mismatch": "warning",
  "orphan-media": "warning",
  "media-marker-missing": "warning",
  "unexpected-file": "warning",
  "leftover-temp-file": "warning",
  "needs-migration": "info",
  "awaiting-sync": "info",
  "media-not-checked": "info",
  // Only a write can produce these two (format-spec §16.2, "Write refusals").
  "write-conflict": "error",
  "not-allowed": "error",
} as const satisfies Record<string, Severity>;

export type IssueCode = keyof typeof ISSUE_SEVERITY;

export interface Issue {
  severity: Severity;
  code: IssueCode;
  /** Path relative to the library, with `/`; `null` for the library as a whole. Never absolute. */
  file: string | null;
  /** RFC 6901 JSON Pointer inside the file, or `null`. */
  pointer: string | null;
  message: string;
}

/** Builds an issue with the severity the format gives its code. */
export function makeIssue(
  code: IssueCode,
  file: string | null,
  pointer: string | null,
  message: string,
): Issue {
  return { severity: ISSUE_SEVERITY[code], code, file, pointer, message };
}
