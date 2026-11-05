import type { FileStatus } from "../validation/file.js";

/**
 * Write plans (docs/design.md section 3, "Core modules and API"; section 4, "Writing library
 * files"): what an operation wants written, built from the gated snapshot and handed to the write
 * pipeline. Pure: plain data in and out.
 */

/**
 * A change to one library file: `path` relative to the library with `/`, and the new value, or
 * `null` to delete the file.
 */
export interface FileChange {
  path: string;
  next: unknown;
}

/** Why link removal left a file alone (docs/design.md section 4, "Links to files with errors"). */
export type SkipReason = "invalid" | "unreadable" | "newer";

/** A file, or a folder that could not be listed, that the operation chose to leave alone. */
export interface Skipped {
  path: string;
  reason: SkipReason;
}

/** What an operation wants written. */
export interface Plan {
  /** In write order; the first one is the primary change (format-spec §5). */
  changes: FileChange[];
  /** Passed through unchanged to the result. */
  skipped: Skipped[];
  /**
   * Files the plan depends on without changing them, for example the file that holds an entry to
   * delete when that file has errors: the write is refused with their issues when one is not
   * `valid` (docs/design.md section 4, layer 2).
   */
  blockedBy?: string[];
}

/** The reason to give for skipping a file of this status, or `null` for a `valid` file. */
export function skipReasonOf(status: FileStatus): SkipReason | null {
  return status === "valid" ? null : status;
}
