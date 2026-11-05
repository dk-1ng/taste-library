import type { CrossFile } from "../validation/cross.js";

/**
 * The version summary of the index (docs/design.md section 4, "Index" and "Write gate";
 * format-spec §15.1, §15.2). Pure. The cross-file checks report `needs-migration` and
 * `mixed-format-versions` from it, and the write gate reads it, so both follow one rule.
 */

export interface VersionSummary {
  /** The version in `library.json` when it is `valid` or `newer`; `null` when it is unknown. */
  library: number | null;
  /** Every version a file states (files `valid`, `invalid` or `newer`), ascending, without repeats. */
  present: readonly number[];
  /** The files of a newer version than this tool supports, sorted by path. */
  newer: readonly string[];
  /** Files other than `library.json`, `valid` or `invalid`, whose version differs from the library's, sorted by path. */
  mixedFiles: readonly string[];
  /** `library.json` is `valid` and below the version this tool writes. */
  needsMigration: boolean;
}

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function versionSummary(
  files: ReadonlyMap<string, CrossFile>,
  current: number,
): VersionSummary {
  const library = files.get("library.json");
  const libraryVersion =
    library !== undefined && (library.status === "valid" || library.status === "newer")
      ? library.formatVersion
      : null;
  const present = new Set<number>();
  const newer: string[] = [];
  const mixedFiles: string[] = [];
  for (const [path, file] of files) {
    if (file.status === "unreadable" || file.formatVersion === null) continue;
    present.add(file.formatVersion);
    if (file.status === "newer") newer.push(path);
    else if (
      path !== "library.json" &&
      libraryVersion !== null &&
      file.formatVersion !== libraryVersion
    ) {
      mixedFiles.push(path);
    }
  }
  return {
    library: libraryVersion,
    present: [...present].sort((a, b) => a - b),
    newer: newer.sort(compareText),
    mixedFiles: mixedFiles.sort(compareText),
    needsMigration:
      library?.status === "valid" && libraryVersion !== null && libraryVersion < current,
  };
}
