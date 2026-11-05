import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  classifyEntry,
  currentLayout,
  FORMAT_REGISTRY,
  type FormatRegistry,
  type LibraryFileKind,
} from "../format.js";
import { type Issue, makeIssue } from "../validation/issue.js";
import {
  buildSnapshot,
  type EntryRead,
  type LibraryEntry,
  type Snapshot,
} from "../validation/library.js";
import { mapLimit } from "./map-limit.js";
import { readLibraryFileBytes } from "./read-file.js";

/**
 * Opening a library: listing its folders and reading its files (docs/design.md section 4,
 * "Reading library files", "I/O"; section 3, "Core modules and API"). The listing and the reads
 * are here because they touch the operating system; every check is in the pure modules.
 */

/** Reads in flight at once (docs/design.md section 4). */
const READ_CONCURRENCY = 16;

export interface OpenOptions {
  /** The format registry; the production one by default, tests pass one with another version. */
  registry?: FormatRegistry;
  /** SHA-256 of bytes as lowercase hex, for `proposal-stale`; `node:crypto` by default. */
  sha256?: (bytes: Uint8Array) => string;
  /** Replaces `readdir` (tests inject listing failures that cannot be made portably). */
  readdir?: typeof readdir;
}

/** Failures that are not validation issues (docs/design.md section 3): the command line turns them into exit 2. */
export type OpenFailure = {
  ok: false;
  code: "not-a-library" | "unreadable-folder";
  message: string;
};

export type SnapshotResult = { ok: true; snapshot: Snapshot } | OpenFailure;

export interface Library {
  /**
   * A snapshot of the library as it is now. The first call after `openLibrary` returns what was
   * read while opening; every later call reads the folders and files again. Reusing the entries of
   * unchanged files by their fingerprints arrives with the index (#36).
   */
  snapshot(): Promise<SnapshotResult>;
}

export type OpenResult = { ok: true; library: Library } | OpenFailure;

const sha256Hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

interface Listed {
  /** Relative to the library, NFC, with `/`. */
  path: string;
  /** The names as the file system gave them, to read the file back. */
  ioSegments: string[];
  kind: LibraryFileKind;
  /** The errno code when the entry is a symbolic link that cannot be followed: the file cannot be read. */
  brokenLink: string | null;
}

interface Listing {
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

function errno(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  // An error without an errno code (or a Node argument error) is a bug, not an unreadable folder.
  if (typeof code !== "string" || code.startsWith("ERR_")) throw error;
  return code;
}

/** Lists the format folders. Throws only for the library folder itself; a subfolder that cannot be read is an issue. */
async function listLibrary(
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

async function load(
  root: string,
  registry: FormatRegistry,
  sha256: (bytes: Uint8Array) => string,
  list: typeof readdir,
): Promise<SnapshotResult> {
  let listing: Listing;
  try {
    listing = await listLibrary(root, registry, list);
  } catch (error) {
    return {
      ok: false,
      code: "unreadable-folder",
      message: `The library folder cannot be read (${errno(error)}).`,
    };
  }
  const notALibrary: OpenFailure = {
    ok: false,
    code: "not-a-library",
    message: "The folder has no library.json, so it is not a library.",
  };
  if (!listing.files.some((file) => file.path === "library.json")) return notALibrary;

  const reads = await mapLimit(listing.files, READ_CONCURRENCY, async (file) => {
    // A link that cannot be followed is reported, never dropped as if the file were deleted.
    if (file.brokenLink !== null) {
      const issue = makeIssue(
        "unreadable-file",
        file.path,
        null,
        `The path is a symbolic link that cannot be followed (${file.brokenLink}).`,
      );
      return { file, result: { status: "failed", issue } as const };
    }
    const result = await readLibraryFileBytes(join(root, ...file.ioSegments), file.path);
    return { file, result };
  });
  const entries: LibraryEntry[] = [];
  for (const { file, result } of reads) {
    // A file that disappeared between the listing and the read is treated as deleted.
    if (result.status === "missing") {
      if (file.path === "library.json") return notALibrary;
      continue;
    }
    const read: EntryRead =
      result.status === "ok"
        ? { status: "ok", bytes: result.bytes }
        : { status: "failed", issue: result.issue };
    entries.push({ path: file.path, kind: file.kind, read });
  }
  return {
    ok: true,
    snapshot: buildSnapshot(registry, entries, listing.issues, sha256, listing.unlisted),
  };
}

/**
 * Opens the library in `root`: lists its folders, reads every file once, checks them and returns
 * a handle. `not-a-library` (no `library.json`) and `unreadable-folder` are results, never thrown;
 * the command line turns them into exit 2 (format-spec §16.1).
 */
export async function openLibrary(root: string, options: OpenOptions = {}): Promise<OpenResult> {
  const registry = options.registry ?? FORMAT_REGISTRY;
  const sha256 = options.sha256 ?? sha256Hex;
  const list = options.readdir ?? readdir;
  const first = await load(root, registry, sha256, list);
  if (!first.ok) return first;
  let pending: SnapshotResult | null = first;
  return {
    ok: true,
    library: {
      async snapshot() {
        if (pending !== null) {
          const result = pending;
          pending = null;
          return result;
        }
        return load(root, registry, sha256, list);
      },
    },
  };
}
