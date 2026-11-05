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

/** Runs `fn` over `items` with at most `limit` in flight; results keep the order of `items`. */
async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

interface Listed {
  /** Relative to the library, NFC, with `/`. */
  path: string;
  /** The names as the file system gave them, to read the file back. */
  ioSegments: string[];
  kind: LibraryFileKind;
}

interface Listing {
  files: Listed[];
  issues: Issue[];
}

async function isDirectory(
  entry: { isDirectory(): boolean; isSymbolicLink(): boolean },
  path: string,
): Promise<boolean> {
  if (entry.isDirectory()) return true;
  if (!entry.isSymbolicLink()) return false;
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

function errno(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  // An error without an errno code (or a Node argument error) is a bug, not an unreadable folder.
  if (typeof code !== "string" || code.startsWith("ERR_")) throw error;
  return code;
}

/** Lists the format folders. Throws only for the library folder itself; a subfolder that cannot be read is an issue. */
async function listLibrary(root: string, registry: FormatRegistry): Promise<Listing> {
  const layout = currentLayout(registry);
  const listing: Listing = { files: [], issues: [] };

  const walk = async (relative: string, ioSegments: string[], top: boolean): Promise<void> => {
    let dirents: Dirent[];
    try {
      dirents = await readdir(join(root, ...ioSegments), { withFileTypes: true });
    } catch (error) {
      if (top) throw error;
      listing.issues.push(
        makeIssue(
          "unreadable-file",
          relative,
          null,
          `The folder cannot be read (${errno(error)}).`,
        ),
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
      const directory = await isDirectory(dirent, join(root, ...childIo));
      const entry = classifyEntry(layout, relative, name, directory);
      if (entry.type === "file") {
        listing.files.push({ path: childPath, ioSegments: childIo, kind: entry.kind });
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
): Promise<SnapshotResult> {
  let listing: Listing;
  try {
    listing = await listLibrary(root, registry);
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
  return { ok: true, snapshot: buildSnapshot(registry, entries, listing.issues, sha256) };
}

/**
 * Opens the library in `root`: lists its folders, reads every file once, checks them and returns
 * a handle. `not-a-library` (no `library.json`) and `unreadable-folder` are results, never thrown;
 * the command line turns them into exit 2 (format-spec §16.1).
 */
export async function openLibrary(root: string, options: OpenOptions = {}): Promise<OpenResult> {
  const registry = options.registry ?? FORMAT_REGISTRY;
  const sha256 = options.sha256 ?? sha256Hex;
  const first = await load(root, registry, sha256);
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
        return load(root, registry, sha256);
      },
    },
  };
}
