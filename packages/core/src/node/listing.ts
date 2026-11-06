import type { Dirent } from "node:fs";
import type { readdir } from "node:fs/promises";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { classifyEntry, currentLayout, type FormatRegistry, type FileKind } from "../format.js";
import { type Issue, makeIssue } from "../validation/issue.js";

/**
 * Listing the folders of a library (docs/design.md section 3, "Core modules and API"; section 4,
 * "Reading library files", "I/O"): which files the format knows, the issues of the listing, and
 * the folders that could not be listed.
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
  const layout = currentLayout(registry);
  const listing: Listing = { files: [], issues: [], unlisted: [] };

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
      if (broken !== null && classifyEntry(layout, relative, name, true).type === "folder") {
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
      const entry = classifyEntry(layout, relative, name, directory);
      if (entry.type === "file") {
        listing.files.push({
          path: childPath,
          ioSegments: childIo,
          kind: entry.kind,
          brokenLink: broken,
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
