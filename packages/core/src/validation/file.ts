import type { FormatRegistry, LibraryFileKind } from "../format.js";
import { escapePointerToken, readLibraryJson } from "../json/read.js";
import { type Issue, makeIssue } from "./issue.js";
import { escapeControl, validateValue } from "./zod-issues.js";

/**
 * The checks within one file (docs/design.md section 4, "Reading library files": "Validation"):
 * the strict reader, the version, the schema of the file's own version, the name against the
 * identifier inside, and the canonical form. Pure: bytes in, a verdict out.
 */

/** `valid`: no error. `invalid`: it has an error. `newer`: its version is above the tool's, so it is not checked further. `unreadable`: it could not be read at all. */
export type FileStatus = "valid" | "invalid" | "newer" | "unreadable";

export interface FileCheck {
  status: FileStatus;
  /** The file's `formatVersion` when it is a positive integer, otherwise `null`. */
  formatVersion: number | null;
  /** The parsed value, only when the file is `valid`. */
  value: unknown;
  issues: Issue[];
}

function versionOf(value: unknown): number | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const version = (value as { formatVersion?: unknown }).formatVersion;
  return typeof version === "number" && Number.isSafeInteger(version) && version >= 1
    ? version
    : null;
}

/** Checks one library file. `path` is relative to the library, with `/`. */
export function checkLibraryFile(
  registry: FormatRegistry,
  kind: LibraryFileKind,
  path: string,
  bytes: Uint8Array,
): FileCheck {
  const read = readLibraryJson(bytes, path);
  if (!read.ok) return { status: "invalid", formatVersion: null, value: null, issues: read.issues };

  const formatVersion = versionOf(read.value);
  if (formatVersion !== null && formatVersion > registry.current) {
    return {
      status: "newer",
      formatVersion,
      value: null,
      issues: [
        makeIssue(
          "newer-format",
          path,
          "/formatVersion",
          `formatVersion: ${formatVersion} is newer than ${registry.current}, the newest version this tool supports; update the tool. The file was not checked further.`,
        ),
      ],
    };
  }

  // A file of an older version is checked against the schemas of its own version; an unknown or
  // missing version is checked against the current ones, which report it.
  const spec =
    (formatVersion === null ? undefined : registry.versions[formatVersion]) ??
    registry.versions[registry.current];
  if (spec === undefined) throw new Error(`The registry has no version ${registry.current}.`);

  const issues = validateValue(spec.schemas[kind], read.value, path);

  const identity = spec.layout.identityOf(path, kind);
  if (identity !== null) {
    const pointer = `/${escapePointerToken(identity.field)}`;
    const given = (read.value as Record<string, unknown>)[identity.field];
    // A value that breaks its own rule is reported by that rule, not again as a name mismatch.
    const reported = issues.some((issue) => issue.pointer === pointer);
    if (
      typeof given === "string" &&
      !reported &&
      given.normalize("NFC") !== identity.name.normalize("NFC")
    ) {
      issues.push(
        makeIssue(
          "name-mismatch",
          path,
          pointer,
          `${identity.field}: the file is named for ${escapeControl(JSON.stringify(identity.name))} but holds ${escapeControl(JSON.stringify(given))}.`,
        ),
      );
    }
  }

  const hasError = issues.some((issue) => issue.severity === "error");
  if (!hasError) {
    const canonical = spec.canonical?.(kind, path, bytes, read);
    if (canonical) issues.push(canonical);
  }
  return {
    status: hasError ? "invalid" : "valid",
    formatVersion,
    value: hasError ? null : read.value,
    issues,
  };
}
