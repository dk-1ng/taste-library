import { realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

/**
 * Turns a `MediaPath` (format-spec §6.2) into a file path inside the media folder. Shared by the
 * validation of the media folder and, in M2, by the serving and writing of media.
 */

export type ResolvedMedia =
  /** `path` is the real path (symbolic links resolved), inside the media folder. */
  | { status: "ok"; path: string }
  /** The file does not exist (a link whose target is missing counts as missing). */
  | { status: "missing" }
  /** The path, once links are resolved, leaves the media folder: it must not be read or written. */
  | { status: "outside" }
  /** The path cannot be resolved for another reason; `code` is the errno code. */
  | { status: "failed"; code: string };

/** The parts of a media path, or `null` when any part could climb out of the folder. */
export function mediaPathSegments(mediaPath: string): string[] | null {
  const segments = mediaPath.split("/");
  const safe = segments.every(
    (segment) => segment !== "" && segment !== "." && segment !== ".." && !/[\\:\0]/.test(segment),
  );
  return safe ? segments : null;
}

function errnoOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  // An error without an errno code (or a Node argument error) is a bug, not an unreadable path.
  if (typeof code !== "string" || code.startsWith("ERR_")) throw error;
  return code;
}

/** Whether `child` is `parent` or lies under it; both are real paths. */
function isInside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

/**
 * Resolves `mediaPath` against `mediaFolder`: the path is split on `/` and joined with the
 * platform's functions, then both ends are resolved with `realpath`. A file that ends up outside
 * the media folder is `outside`; nothing is read to decide it.
 */
export async function resolveMediaPath(
  mediaFolder: string,
  mediaPath: string,
): Promise<ResolvedMedia> {
  const segments = mediaPathSegments(mediaPath);
  if (segments === null) return { status: "outside" };
  let folder: string;
  try {
    folder = await realpath(mediaFolder);
  } catch (error) {
    return { status: "failed", code: errnoOf(error) };
  }
  let real: string;
  try {
    real = await realpath(join(folder, ...segments));
  } catch (error) {
    const code = errnoOf(error);
    return code === "ENOENT" || code === "ENOTDIR"
      ? { status: "missing" }
      : { status: "failed", code };
  }
  // The folder itself is not a file of the folder.
  return isInside(folder, real) && real !== folder
    ? { status: "ok", path: real }
    : { status: "outside" };
}
