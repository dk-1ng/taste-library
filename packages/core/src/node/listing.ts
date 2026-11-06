import type { Dirent } from "node:fs";
import type { readdir } from "node:fs/promises";
import { realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { classifyListedEntry, type FileKind, type FormatRegistry } from "../format.js";
import { type Issue, makeIssue } from "../validation/issue.js";
import { isInside } from "./folders.js";

/**
 * Listing the folders of a library (docs/design.md section 3, "Core modules and API"; section 4,
 * "Reading library files", "I/O" and "Which files are listed"): which files the format knows, with
 * the folder layouts of every version the registry supports (format-spec §15.2), the issues of the
 * listing, and the folders that could not be listed.
 */

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export interface Listed {
  /** Relative to the library, NFC, with `/`. */
  path: string;
  /** The names as the file system gave them, to read the file back. */
  ioSegments: string[];
  kind: FileKind;
  /** The errno code when the entry is a symbolic link that cannot be followed: the file cannot be read. */
  brokenLink: string | null;
  /**
   * Set when the entry is a link that leaves the library (`outside`) or leads into its own
   * `.tastelib/` or `.git/` (`own`): the file is never opened.
   */
  refusal: Refusal | null;
}

export type Refusal = "outside" | "own";

/** The message of an `unreadable-file` for a file link that is refused. It never says where the link leads. */
export function refusedFileMessage(refusal: Refusal): string {
  return refusal === "outside"
    ? "The file is a symbolic link or junction that leads outside the library and was not read."
    : "The file is a symbolic link or junction that leads into the library's own working or Git folder and was not read. Remove the link.";
}

function refusedFolderMessage(refusal: Refusal): string {
  return refusal === "outside"
    ? "The folder is a symbolic link or junction that leads outside the library."
    : "The folder is a symbolic link or junction that leads into the library's own working or Git folder. Remove the link.";
}

/**
 * Where a link at `path` leads, on real folders: outside the library's real folder (`outside`),
 * into its `.tastelib/` or `.git/` (`own`), or nowhere that is refused. An absent `.tastelib/` or
 * `.git/` refuses nothing; a link whose position cannot be decided is refused.
 */
async function refusalOf(path: string, realRoot: string): Promise<Refusal | null> {
  const inside = await isInside(path, realRoot);
  if (inside.status === "failed" || !inside.contained) return "outside";
  for (const name of [".tastelib", ".git"]) {
    const own = await isInside(path, join(realRoot, name));
    if (own.status === "failed") {
      if (own.errno === "ENOENT" || own.errno === "ENOTDIR") continue;
      return "own";
    }
    if (own.contained) return "own";
  }
  return null;
}

export interface Listing {
  files: Listed[];
  issues: Issue[];
  /** Folders (relative paths) that exist but could not be listed: the links into them are unresolved. */
  unlisted: string[];
}

/** Whether an entry is a folder (following a symbolic link), and the errno code when it is a symbolic link that cannot be followed. */
async function inspect(
  entry: { isDirectory(): boolean; isSymbolicLink(): boolean },
  path: string,
): Promise<{ directory: boolean; broken: string | null }> {
  if (entry.isDirectory()) return { directory: true, broken: null };
  if (!entry.isSymbolicLink()) return { directory: false, broken: null };
  try {
    return { directory: (await stat(path)).isDirectory(), broken: null };
  } catch (error) {
    return { directory: false, broken: errno(error) };
  }
}

export function errno(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  // An error without an errno code (or a Node argument error) is a bug, not an unreadable folder.
  if (typeof code !== "string" || code.startsWith("ERR_")) throw error;
  return code;
}

/** Lists the format folders. Throws only for the library folder itself; a subfolder that cannot be read is an issue. */
export async function listLibrary(
  root: string,
  registry: FormatRegistry,
  list: typeof readdir,
): Promise<Listing> {
  const listing: Listing = { files: [], issues: [], unlisted: [] };
  // The library's real folder, resolved once and only when the first link is met.
  let realRoot: Promise<string> | null = null;
  const realRootOf = (): Promise<string> => (realRoot ??= realpath(root));

  const walk = async (relative: string, ioSegments: string[], top: boolean): Promise<void> => {
    let dirents: Dirent[];
    try {
      dirents = await list(join(root, ...ioSegments), { withFileTypes: true });
    } catch (error) {
      if (top) throw error;
      // A folder that disappeared since its parent was listed is treated as deleted.
      const code = errno(error);
      if (code === "ENOENT" || code === "ENOTDIR") return;
      listing.unlisted.push(relative);
      listing.issues.push(
        makeIssue("unreadable-file", relative, null, `The folder cannot be read (${code}).`),
      );
      return;
    }
    // Names are compared and reported in NFC; the file system may return another form (docs/design.md section 13).
    const named = dirents
      .map((dirent) => ({ dirent, name: dirent.name.normalize("NFC") }))
      .sort((a, b) => compareText(a.name, b.name));
    for (const { dirent, name } of named) {
      const childPath = relative === "" ? name : `${relative}/${name}`;
      const childIo = [...ioSegments, dirent.name];
      const { directory, broken } = await inspect(dirent, join(root, ...childIo));
      // A link that cannot be followed where a format folder belongs: the folder cannot be listed.
      if (
        broken !== null &&
        classifyListedEntry(registry, relative, name, true).type === "folder"
      ) {
        listing.unlisted.push(childPath);
        listing.issues.push(
          makeIssue(
            "unreadable-file",
            childPath,
            null,
            `The folder is a symbolic link that cannot be followed (${broken}).`,
          ),
        );
        continue;
      }
      const entry = classifyListedEntry(registry, relative, name, directory);
      // A link that is followed must stay inside the library (docs/design.md section 4, "Reading
      // library files"): the entries `readdir` reports as links are the only ones checked.
      let refusal: Refusal | null = null;
      if (dirent.isSymbolicLink() && broken === null && entry.type === "folder") {
        refusal = await refusalOf(join(root, ...childIo), await realRootOf());
        if (refusal !== null) {
          listing.unlisted.push(childPath);
          listing.issues.push(
            makeIssue("unreadable-file", childPath, null, refusedFolderMessage(refusal)),
          );
          continue;
        }
      } else if (dirent.isSymbolicLink() && broken === null && entry.type === "file") {
        refusal = await refusalOf(join(root, ...childIo), await realRootOf());
      }
      if (entry.type === "file") {
        listing.files.push({
          path: childPath,
          ioSegments: childIo,
          kind: entry.kind,
          brokenLink: broken,
          refusal,
        });
      } else if (entry.type === "folder") {
        await walk(childPath, childIo, false);
      } else if (entry.type === "unexpected") {
        listing.issues.push(
          makeIssue(
            "unexpected-file",
            childPath,
            null,
            directory
              ? "This folder is not part of the format and is ignored."
              : "This file is not part of the format and is ignored.",
          ),
        );
      } else if (entry.type === "leftover-temp-file") {
        listing.issues.push(
          makeIssue(
            "leftover-temp-file",
            childPath,
            null,
            "A write was interrupted and left this temporary file; it is safe to delete.",
          ),
        );
      }
    }
  };

  await walk("", [], true);
  return listing;
}
