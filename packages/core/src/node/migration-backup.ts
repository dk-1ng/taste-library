import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

/**
 * The migration backup (format-spec §15.3; docs/design.md section 4, "Format versions"): where it
 * lives, and the shape of its two files of its own, `owner.json` and `manifest.json`. They are
 * internal to `tastelib`, not part of the format, and never committed (`.tastelib/` is ignored).
 * The migration runner writes them (`migrate.ts`); recovery and `tastelib doctor` read them back
 * with the same strict schemas, so a file of any other shape is unreadable (format-spec §15.3,
 * recovery cases 1 and 4).
 *
 * Layout, relative to the library:
 *
 * - `.tastelib/migration-backup/owner.json`: who claimed the backup and when.
 * - `.tastelib/migration-backup/files/<path>`: the copy of each library file the migration changes
 *   or removes, at its own relative path.
 * - `.tastelib/migration-backup/manifest.json`: written once every copy is in place.
 */

/** The tool's working folder, relative to the library. */
export const TOOL_FOLDER = ".tastelib";

/** The migration backup folder, relative to the library (format-spec §15.3). */
export const BACKUP = `${TOOL_FOLDER}/migration-backup`;

/** The owner file of the backup, relative to the library. */
export const OWNER_FILE = `${BACKUP}/owner.json`;

/** The manifest of the backup, relative to the library. */
export const MANIFEST_FILE = `${BACKUP}/manifest.json`;

/** The folder of the copies inside the backup, relative to the library. */
export const COPIES = `${BACKUP}/files`;

/** Where the backup keeps its copy of the library file at `path` (relative to the library, with `/`). */
export function copyPathOf(path: string): string {
  return `${COPIES}/${path}`;
}

/** The absolute path of `relative` (with `/`) under `root`. */
export function pathIn(root: string, relative: string): string {
  return join(root, ...relative.split("/"));
}

/** One name of a library path: no `.` or `..`, no separator, no drive or stream colon. */
const SAFE_NAME = /^[A-Za-z0-9._-]+$/;

/**
 * Whether `path` is a relative path that stays where it says (docs/design.md section 14): names
 * of letters, digits, `.`, `_` and `-` joined by `/`, none of them empty, `.` or `..`. Every path
 * the format produces has this form, since its names come from identifiers that match the format's
 * patterns; anything else in a manifest is refused, so no path read back from the backup can lead
 * a restore or a removal outside the library.
 */
export function isSafeRelativePath(path: string): boolean {
  return path.split("/").every((name) => SAFE_NAME.test(name) && name !== "." && name !== "..");
}

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** A UTC time with milliseconds that names a real time, as the claim time is written. */
const claimTime = z
  .string()
  .refine(
    (value) => TIMESTAMP.test(value) && new Date(value).toISOString() === value,
    'must be a UTC time with milliseconds, like "2026-11-04T12:00:00.000Z"',
  );

/**
 * `owner.json`: the process that claimed the backup, its computer's host name, and the time of the
 * claim. A process id that is not an integer from 1 to 2^31 - 1 makes the file unreadable:
 * `process.kill(0, 0)` and `process.kill(-1, 0)` signal a process group or every process, and Node
 * refuses ids above 2^31 - 1 (docs/design.md section 15, "The process probe").
 */
export const ownerSchema = z.strictObject({
  pid: z
    .number()
    .int()
    .min(1)
    .max(2 ** 31 - 1),
  host: z.string().max(255),
  claimedAt: claimTime,
});

export type BackupOwner = z.infer<typeof ownerSchema>;

/** A library path as the manifest lists it: relative, with `/`, and safe ({@link isSafeRelativePath}). */
const libraryPath = z.string().refine(isSafeRelativePath, "must be a relative library path");

/**
 * `manifest.json`: the state of the migration (`in-progress` once every copy is in place, `done`
 * once every library file is written), the version it migrates to, and the files it adds, sorted,
 * which a restore removes (format-spec §15.3 steps 4 and 6, recovery case 7).
 */
export const manifestSchema = z.strictObject({
  state: z.enum(["in-progress", "done"]),
  toVersion: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  added: z
    .array(libraryPath)
    .refine(
      (paths) => paths.every((path, index) => index === 0 || (paths[index - 1] as string) < path),
      "must be sorted, without repeats",
    ),
});

export type BackupManifest = z.infer<typeof manifestSchema>;

/** The bytes of a backup file: two-space JSON plus LF, like every file the tool writes. */
export function backupFileBytes(value: BackupOwner | BackupManifest): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`);
}

function errnoOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && !code.startsWith("ERR_") ? code : undefined;
}

/**
 * Whether `.tastelib/migration-backup/` exists, looked at now with `lstat` and never cached
 * (format-spec §15.3), so a link there counts even when it leads nowhere. An error with an errno
 * other than "not there" is thrown as it is.
 */
export async function backupPresent(
  root: string,
  lstatFn: (path: string) => Promise<unknown> = lstat,
): Promise<boolean> {
  try {
    await lstatFn(pathIn(root, BACKUP));
    return true;
  } catch (error) {
    const errno = errnoOf(error);
    if (errno === "ENOENT" || errno === "ENOTDIR") return false;
    throw error;
  }
}
