import type { FileKind, FormatRegistry } from "../format.js";
import type { LibraryIndex } from "../library-index/build.js";
import { afterMigration, migrationOf } from "../migrations/plan.js";
import { checkLibraryFile, type FileStatus } from "./file.js";
import type { Issue } from "./issue.js";
import { buildReport, mediaNotChecked, type Report, sortIssues } from "./report.js";
import { assembleView } from "./view.js";

/**
 * The snapshot of a library (docs/design.md section 3, "Core modules and API") and the pure
 * functions that build it from what was read: the checks within each file, then the checks across
 * files and the index. Pure: the reading of the folder is in `node/`.
 */

/** What reading one listed file gave: its exact bytes, or the issue that tells why not. */
export type EntryRead = { status: "ok"; bytes: Uint8Array } | { status: "failed"; issue: Issue };

export interface LibraryEntry {
  /** Relative to the library, with `/`, in Unicode NFC. */
  path: string;
  kind: FileKind;
  read: EntryRead;
  /** The fingerprint of what was read (docs/design.md section 4, "Index", "Freshness"); `null` by default. */
  fingerprint?: string | null;
}

export interface SnapshotFile {
  path: string;
  kind: FileKind;
  /** The exact bytes read, kept for the optimistic write check (format-spec §5); `null` when the file could not be read. */
  bytes: Uint8Array | null;
  /** `(size, mtime, ctime, inode)` of the file read, or `null` (a snapshot built in memory, or bytes just written). */
  fingerprint: string | null;
  formatVersion: number | null;
  status: FileStatus;
  /** The parsed value, only when the file is `valid`, at the file's own version (an older file is not migrated here; see `Snapshot.migrated`). */
  value: unknown;
  /** The issues of this file alone, checked against the schemas of its own version: those within it, not the cross-file ones. */
  issues: readonly Issue[];
}

export interface Snapshot {
  /** The version in `library.json`, or `null` when it cannot be read. */
  formatVersion: number | null;
  /** Sorted by relative path. Each file's kind, fingerprint, version and status live here. */
  files: ReadonlyMap<string, SnapshotFile>;
  /**
   * The library as the migration to the current version would leave it, built in memory by the
   * planner (format-spec §15.3 steps 1 to 3), when the library is older or mixed and the migration
   * can run: its files at their migrated paths, every fingerprint `null`, and its own `migrated`
   * `null`. Otherwise (a current library, or a migration that cannot run) `null`.
   */
  migrated: Snapshot | null;
  /** Every issue of the library, sorted as in format-spec §16.3; media issues are separate (`checkMedia`). */
  issues: readonly Issue[];
  /** Folders (relative paths) that exist but could not be listed: a link into one is unresolved, not dangling. */
  unlistedFolders: readonly string[];
  /**
   * The index (docs/design.md section 4, "Index"), built from the parsed files: from `migrated`
   * when there is one, with the version summary of the files on disk.
   */
  index: LibraryIndex;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The checks within one file: the work per file, which a refresh reuses for a file whose
 * fingerprint or bytes did not change (docs/design.md section 4, "Index", "How it is built").
 */
export function checkEntry(registry: FormatRegistry, entry: LibraryEntry): SnapshotFile {
  const fingerprint = entry.fingerprint ?? null;
  if (entry.read.status === "failed") {
    return {
      path: entry.path,
      kind: entry.kind,
      bytes: null,
      fingerprint,
      formatVersion: null,
      status: "unreadable",
      value: null,
      issues: [entry.read.issue],
    };
  }
  const check = checkLibraryFile(registry, entry.kind, entry.path, entry.read.bytes);
  return {
    path: entry.path,
    kind: entry.kind,
    bytes: entry.read.bytes,
    fingerprint,
    formatVersion: check.formatVersion,
    status: check.status,
    value: check.value,
    issues: check.issues,
  };
}

/** The codes of the checks across files that come from the versions of the files on disk (format-spec §15.2). */
const VERSION_CODES: ReadonlySet<string> = new Set(["needs-migration", "mixed-format-versions"]);

/**
 * Everything library-wide, from the checked files: the cross-file checks, the version summary,
 * the migrated view and the index, recomputed in full each time (docs/design.md section 3, "Core
 * modules and API"; section 4, "Index", "How it is built"). `folderIssues` are those found while
 * listing the folders (`unexpected-file`, `leftover-temp-file`, an unreadable folder).
 *
 * In an older or mixed library whose migration can run, `migrated` is the library as the
 * migration would leave it (`migrations/plan.ts`); the checks across files and the index come
 * from it, and the report holds the issues of the files on disk and of the listing, the version
 * issues, and the issues across files of `migrated` at their migrated paths. When the migration
 * cannot run, `migrated` is `null`, the checks across files run on the files on disk (older files
 * take no part in links), and the errors left at step 3 are reported at their migrated paths.
 */
export function assembleSnapshot(
  registry: FormatRegistry,
  checked: Iterable<SnapshotFile>,
  folderIssues: readonly Issue[],
  sha256: (bytes: Uint8Array) => string,
  /** Folders (relative paths) that exist but could not be listed: a link into one is unresolved, not dangling. */
  unlistedFolders: readonly string[] = [],
): Snapshot {
  const files = new Map<string, SnapshotFile>();
  for (const file of [...checked].sort((a, b) => compareText(a.path, b.path))) {
    files.set(file.path, file);
  }
  const disk = assembleView(registry, files, folderIssues, sha256, unlistedFolders);
  const versions = disk.snapshot.index.versions;
  const { plan, cross } = migrationOf(
    registry,
    { files, unlistedFolders, issues: folderIssues },
    sha256,
    versions,
  );
  if (plan.status === "current") return disk.snapshot;
  if (plan.status === "blocked") {
    if (plan.step === 1) return disk.snapshot;
    return { ...disk.snapshot, issues: sortIssues([...disk.snapshot.issues, ...plan.issues]) };
  }
  const migrated = plan.migrated;
  return {
    ...disk.snapshot,
    migrated,
    issues: sortIssues([
      ...disk.own,
      ...disk.cross.filter((issue) => VERSION_CODES.has(issue.code)),
      ...cross.map((issue) => afterMigration(issue, registry.current)),
    ]),
    index: { ...migrated.index, versions },
  };
}

/** Builds the snapshot from what was read: `checkEntry` for each file, then `assembleSnapshot`. */
export function buildSnapshot(
  registry: FormatRegistry,
  entries: readonly LibraryEntry[],
  folderIssues: readonly Issue[],
  sha256: (bytes: Uint8Array) => string,
  /** Folders (relative paths) that exist but could not be listed: a link into one is unresolved, not dangling. */
  unlistedFolders: readonly string[] = [],
): Snapshot {
  return assembleSnapshot(
    registry,
    entries.map((entry) => checkEntry(registry, entry)),
    folderIssues,
    sha256,
    unlistedFolders,
  );
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
