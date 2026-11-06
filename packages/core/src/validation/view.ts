import type { FormatRegistry } from "../format.js";
import { buildIndex } from "../library-index/build.js";
import { buildTargets } from "../library-index/targets.js";
import { versionSummary } from "../library-index/versions.js";
import { type CrossFile, crossFileIssues, type LinkEvent } from "./cross.js";
import type { Issue } from "./issue.js";
import type { Snapshot, SnapshotFile } from "./library.js";
import { sortIssues } from "./report.js";

/**
 * One view of a library as it is given, with no migration: the checks across files, the version
 * summary and the index, from files already checked one by one. Pure. `assembleSnapshot`
 * (`library.ts`) builds the files on disk with it, and the migration planner
 * (`migrations/plan.ts`) the library as the migration would leave it, so both run the same
 * checks.
 */

export interface View {
  /** The snapshot of these files, with `migrated` always `null`. */
  snapshot: Snapshot;
  /** The issues of the listing and of each file alone. */
  own: readonly Issue[];
  /** The issues of the checks across files: versions, links, stale proposals, duplicate terms. */
  cross: readonly Issue[];
}

/** The files of a snapshot as the checks across files take them. */
export function crossFilesOf(files: ReadonlyMap<string, SnapshotFile>): Map<string, CrossFile> {
  const cross = new Map<string, CrossFile>();
  for (const [path, file] of files) {
    cross.set(path, {
      kind: file.kind,
      status: file.status,
      formatVersion: file.formatVersion,
      value: file.value,
    });
  }
  return cross;
}

/**
 * The view of `files`, which must be sorted by path. `folderIssues` are those found while listing
 * the folders; `unlistedFolders` are the folders that exist but could not be listed.
 */
export function assembleView(
  registry: FormatRegistry,
  files: ReadonlyMap<string, SnapshotFile>,
  folderIssues: readonly Issue[],
  sha256: (bytes: Uint8Array) => string,
  unlistedFolders: readonly string[],
): View {
  const own: Issue[] = [...folderIssues];
  for (const file of files.values()) own.push(...file.issues);

  const cross = crossFilesOf(files);
  const current = registry.current;
  const versions = versionSummary(cross, current);
  const targets = buildTargets(cross, current, unlistedFolders);
  const links: LinkEvent[] = [];
  const crossIssues = crossFileIssues(cross, {
    current,
    sha256,
    unlistedFolders,
    versions,
    targets,
    onLink: (link) => void links.push(link),
  });

  return {
    snapshot: {
      formatVersion: files.get("library.json")?.formatVersion ?? null,
      files,
      migrated: null,
      issues: sortIssues([...own, ...crossIssues]),
      unlistedFolders,
      index: buildIndex({ files: cross, current, targets, links, versions }),
    },
    own,
    cross: crossIssues,
  };
}
