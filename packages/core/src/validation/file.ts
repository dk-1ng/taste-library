import type { FormatRegistry, FileKind } from "../format.js";
import { escapePointerToken, readLibraryJson } from "../json/read.js";
import { type Issue, makeIssue } from "./issue.js";
import { escapeControl, parseValue } from "./zod-issues.js";

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

export function versionOf(value: unknown): number | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const version = (value as { formatVersion?: unknown }).formatVersion;
  return typeof version === "number" && Number.isSafeInteger(version) && version >= 1
    ? version
    : null;
}

/** Checks one library file. `path` is relative to the library, with `/`. */
export function checkLibraryFile(
  registry: FormatRegistry,
  kind: FileKind,
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

  // A path that the file's own version does not have: it belongs to another version (format-spec
  // §15.2), so its version is wrong for where it sits and nothing else of it can be checked.
  const schema = Object.hasOwn(spec.schemas, kind) ? spec.schemas[kind] : undefined;
  if (schema === undefined) {
    return {
      status: "invalid",
      formatVersion,
      value: null,
      issues: [
        makeIssue(
          "schema-violation",
          path,
          "/formatVersion",
          formatVersion === null
            ? "formatVersion: must be a format version that has a file at this path."
            : `formatVersion: format version ${formatVersion} has no file at this path.`,
        ),
      ],
    };
  }
  const parsed = parseValue(schema, read.value, path);
  const issues = parsed.issues;

  const identity = spec.layout.identityOf(path, kind);
  // A value that is not an object (`null`, a number) has no identity field; the schema reports it.
  if (identity !== null && typeof read.value === "object" && read.value !== null) {
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
  // Every issue of a schema is an error, so a file with no error passed its schema.
  if (!hasError && parsed.success) {
    const canonical = spec.canonical?.(kind, path, read, parsed.data);
    if (canonical) issues.push(canonical);
  }
  return {
    status: hasError ? "invalid" : "valid",
    formatVersion,
    value: hasError ? null : read.value,
    issues,
  };
}
