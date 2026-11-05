import type { FormatRegistry, LibraryFileKind } from "../format.js";
import { type CrossFile, crossFileIssues } from "./cross.js";
import { checkLibraryFile, type FileStatus } from "./file.js";
import type { Issue } from "./issue.js";
import { buildReport, mediaNotChecked, type Report, sortIssues } from "./report.js";

/**
 * The snapshot of a library (docs/design.md section 3, "Core modules and API") and the pure
 * function that builds it from what was read: the checks within each file, then the checks across
 * files. Pure: the reading of the folder is in `node/`.
 */

/** What reading one listed file gave: its exact bytes, or the issue that tells why not. */
export type EntryRead = { status: "ok"; bytes: Uint8Array } | { status: "failed"; issue: Issue };

export interface LibraryEntry {
  /** Relative to the library, with `/`, in Unicode NFC. */
  path: string;
  kind: LibraryFileKind;
  read: EntryRead;
}

export interface SnapshotFile {
  path: string;
  kind: LibraryFileKind;
  /** The exact bytes read, kept for the optimistic write check (format-spec §5); `null` when the file could not be read. */
  bytes: Uint8Array | null;
  formatVersion: number | null;
  status: FileStatus;
  /** The parsed value, only when the file is `valid`. It is not migrated yet: that arrives with the migration runner (#38). */
  value: unknown;
  /** The issues of this file alone: those within it, not the cross-file ones. */
  issues: readonly Issue[];
}

export interface Snapshot {
  /** The version in `library.json`, or `null` when it cannot be read. */
  formatVersion: number | null;
  /** Sorted by relative path. */
  files: ReadonlyMap<string, SnapshotFile>;
  /** Every issue of the library, sorted as in format-spec §16.3; media issues are separate (`checkMedia`). */
  issues: readonly Issue[];
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Builds the snapshot. `folderIssues` are those found while listing the folders (`unexpected-file`,
 * `leftover-temp-file`, an unreadable folder).
 */
export function buildSnapshot(
  registry: FormatRegistry,
  entries: readonly LibraryEntry[],
  folderIssues: readonly Issue[],
  sha256: (bytes: Uint8Array) => string,
): Snapshot {
  const files = new Map<string, SnapshotFile>();
  const issues: Issue[] = [...folderIssues];
  for (const entry of [...entries].sort((a, b) => compareText(a.path, b.path))) {
    let file: SnapshotFile;
    if (entry.read.status === "failed") {
      file = {
        path: entry.path,
        kind: entry.kind,
        bytes: null,
        formatVersion: null,
        status: "unreadable",
        value: null,
        issues: [entry.read.issue],
      };
    } else {
      const check = checkLibraryFile(registry, entry.kind, entry.path, entry.read.bytes);
      file = {
        path: entry.path,
        kind: entry.kind,
        bytes: entry.read.bytes,
        formatVersion: check.formatVersion,
        status: check.status,
        value: check.value,
        issues: check.issues,
      };
    }
    files.set(file.path, file);
    issues.push(...file.issues);
  }

  const cross = new Map<string, CrossFile>();
  for (const [path, file] of files) {
    cross.set(path, {
      kind: file.kind,
      status: file.status,
      formatVersion: file.formatVersion,
      value: file.value,
    });
  }
  issues.push(...crossFileIssues(cross, { current: registry.current, sha256 }));

  return {
    formatVersion: files.get("library.json")?.formatVersion ?? null,
    files,
    issues: sortIssues(issues),
  };
}

/**
 * The report of a snapshot (format-spec §16.3), with the issues of the media folder added. Pass
 * `mediaIssues` from `checkMedia` when a media folder is set; without it, `media-not-checked` is
 * reported once.
 */
export function reportOf(
  registry: FormatRegistry,
  snapshot: Snapshot,
  mediaIssues?: readonly Issue[],
): Report {
  return buildReport({
    libraryFormatVersion: snapshot.formatVersion,
    supportedFormatVersion: registry.current,
    issues: [...snapshot.issues, ...(mediaIssues ?? [mediaNotChecked()])],
  });
}
