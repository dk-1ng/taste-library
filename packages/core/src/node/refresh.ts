import type { BigIntStats } from "node:fs";
import type { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { FormatRegistry, FileKind } from "../format.js";
import type { FileCheck } from "../validation/file.js";
import { type Issue, makeIssue } from "../validation/issue.js";
import {
  assembleSnapshot,
  checkEntry,
  type Snapshot,
  type SnapshotFile,
} from "../validation/library.js";
import { fingerprintOf, isUnsettled } from "./fingerprint.js";
import { errno, type Listed, type Listing, listLibrary } from "./listing.js";
import { mapLimit } from "./map-limit.js";
import type { OpenFailure, SnapshotResult } from "./open.js";
import type { readLibraryFileBytes } from "./read-file.js";

/**
 * Refreshing a library (docs/design.md section 4, "Index", "Freshness" and "How it is built"):
 * list the format folders, `stat` every file, and read again only a file that is new, whose
 * fingerprint changed, or that is unsettled. The work per file is cached by fingerprint; everything
 * library-wide is recomputed from the parsed files whenever anything changed, and when nothing
 * did, the previous snapshot itself is returned. The cache is in memory only, per handle.
 */

/** Reads and stats in flight at once (docs/design.md section 4, "Reading library files", "I/O"). */
const CONCURRENCY = 16;

/** `stat` with `bigint: true`, following symbolic links, as the read does. */
export type StatFn = (path: string, options: { bigint: true }) => Promise<BigIntStats>;

export interface RefreshOptions {
  root: string;
  registry: FormatRegistry;
  sha256: (bytes: Uint8Array) => string;
  list: typeof readdir;
  stat: StatFn;
  /** The system clock in milliseconds, read right after a file is stat'd. */
  statClock: () => number;
  readFile: typeof readLibraryFileBytes;
}

/** What a write gives layer 9: the bytes it wrote with their check, or `null` for a deletion. */
export type Written = { kind: FileKind; bytes: Uint8Array; check: FileCheck } | null;

export interface Refresher {
  /**
   * A snapshot from a refresh that started after this call; calls made while a refresh runs
   * share the next one.
   */
  request(): Promise<SnapshotResult>;
  /** Layer 9 of the write pipeline: the file at `path` was just written (or deleted). */
  wrote(path: string, written: Written): void;
}

interface Cached {
  file: SnapshotFile;
  fingerprint: string | null;
  /** Read again at the next refresh whatever its fingerprint. */
  unsettled: boolean;
  /** The errno of a symbolic link that could not be followed, when that is what was listed. */
  brokenLink: string | null;
}

const NOT_A_LIBRARY: OpenFailure = {
  ok: false,
  code: "not-a-library",
  message: "The folder has no library.json, so it is not a library.",
};

function sameBytes(a: Uint8Array | null, b: Uint8Array): boolean {
  if (a === null || a.length !== b.length) return false;
  for (let index = 0; index < a.length; index++) if (a[index] !== b[index]) return false;
  return true;
}

function sameIssues(a: readonly Issue[], b: readonly Issue[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function createRefresher(options: RefreshOptions): Refresher {
  const { root, registry } = options;
  let cache = new Map<string, Cached>();
  let last: { snapshot: Snapshot; folderIssues: readonly Issue[] } | null = null;
  /** Bumped by every write; `touched` holds the generation of the last write to each path. */
  let generation = 0;
  const touched = new Map<string, number>();

  /** One file of the listing: reused from the cache, or read again. `null` when it is gone. */
  const refreshFile = async (listed: Listed): Promise<Cached | null> => {
    const cached = cache.get(listed.path);
    if (listed.brokenLink !== null) {
      if (cached?.brokenLink === listed.brokenLink) return cached;
      // A link that cannot be followed is reported, never dropped as if the file were deleted.
      const issue = makeIssue(
        "unreadable-file",
        listed.path,
        null,
        `The path is a symbolic link that cannot be followed (${listed.brokenLink}).`,
      );
      const file = checkEntry(registry, {
        path: listed.path,
        kind: listed.kind,
        read: { status: "failed", issue },
      });
      return { file, fingerprint: null, unsettled: false, brokenLink: listed.brokenLink };
    }
    const path = join(root, ...listed.ioSegments);
    if (cached !== undefined && !cached.unsettled && cached.fingerprint !== null) {
      let stats: BigIntStats | null = null;
      try {
        stats = await options.stat(path, { bigint: true });
      } catch (error) {
        // A file that disappeared since the listing is treated as deleted; another error reads it.
        if (errno(error) === "ENOENT") return null;
      }
      if (stats !== null && fingerprintOf(stats) === cached.fingerprint) return cached;
    }
    const read = await options.readFile(path, listed.path);
    // A file that disappeared between the listing and the read is treated as deleted.
    if (read.status === "missing") return null;
    const stats = read.stats ?? null;
    // The fingerprint is the stat of the handle that read these bytes, never a later one.
    const fingerprint = stats === null ? null : fingerprintOf(stats);
    const unsettled = stats !== null && isUnsettled(stats, options.statClock());
    if (
      read.status === "ok" &&
      cached !== undefined &&
      cached.brokenLink === null &&
      cached.file.kind === listed.kind &&
      sameBytes(cached.file.bytes, read.bytes)
    ) {
      const file =
        cached.file.fingerprint === fingerprint ? cached.file : { ...cached.file, fingerprint };
      return { file, fingerprint, unsettled, brokenLink: null };
    }
    // A file that still cannot be read, for the same reason and with the same fingerprint (or none,
    // as when it cannot be opened), is unchanged: its entry is kept, so the snapshot can be too.
    if (
      read.status === "failed" &&
      cached !== undefined &&
      cached.brokenLink === null &&
      cached.file.kind === listed.kind &&
      cached.file.status === "unreadable" &&
      cached.file.fingerprint === fingerprint &&
      sameIssues(cached.file.issues, [read.issue])
    ) {
      return { file: cached.file, fingerprint, unsettled, brokenLink: null };
    }
    const file = checkEntry(registry, {
      path: listed.path,
      kind: listed.kind,
      read:
        read.status === "ok"
          ? { status: "ok", bytes: read.bytes }
          : { status: "failed", issue: read.issue },
      fingerprint,
    });
    return { file, fingerprint, unsettled, brokenLink: null };
  };

  const refreshOnce = async (): Promise<SnapshotResult> => {
    const startGeneration = generation;
    let listing: Listing;
    try {
      listing = await listLibrary(root, registry, options.list);
    } catch (error) {
      return {
        ok: false,
        code: "unreadable-folder",
        message: `The library folder cannot be read (${errno(error)}).`,
      };
    }
    if (!listing.files.some((file) => file.path === "library.json")) return NOT_A_LIBRARY;

    const results = await mapLimit(listing.files, CONCURRENCY, async (listed) => ({
      listed,
      entry: await refreshFile(listed),
    }));
    const next = new Map<string, Cached>();
    for (const { listed, entry } of results) {
      if (entry === null) {
        if (listed.path === "library.json") return NOT_A_LIBRARY;
        continue;
      }
      // A write to this path since the refresh started: what was read may predate it.
      const written = (touched.get(listed.path) ?? -1) > startGeneration;
      next.set(listed.path, written ? { ...entry, unsettled: true } : entry);
    }
    cache = next;

    if (last !== null) {
      const previous = last.snapshot;
      const unchanged =
        previous.files.size === next.size &&
        [...next].every(([path, entry]) => previous.files.get(path) === entry.file) &&
        sameIssues(last.folderIssues, listing.issues) &&
        previous.unlistedFolders.length === listing.unlisted.length &&
        previous.unlistedFolders.every((folder, index) => folder === listing.unlisted[index]);
      if (unchanged) return { ok: true, snapshot: previous };
    }
    const snapshot = assembleSnapshot(
      registry,
      [...next.values()].map((entry) => entry.file),
      listing.issues,
      options.sha256,
      listing.unlisted,
    );
    last = { snapshot, folderIssues: listing.issues };
    return { ok: true, snapshot };
  };

  // Refreshes never overlap, so the cache has one writer. A request is answered by a refresh that
  // starts after it arrives: a refresh starts at the earliest one microtask after the request
  // that asked for it, and once the refresh before it has ended, so the requests that arrive
  // together, or while a refresh runs, share the next one.
  let tail: Promise<unknown> = Promise.resolve();
  let pending: Promise<SnapshotResult> | null = null;
  const request = (): Promise<SnapshotResult> => {
    if (pending !== null) return pending;
    const next = tail
      .then(
        () => undefined,
        () => undefined,
      )
      .then(() => {
        pending = null;
        return refreshOnce();
      });
    pending = next;
    tail = next;
    return next;
  };

  const wrote = (path: string, written: Written): void => {
    generation += 1;
    touched.set(path, generation);
    if (written === null) {
      cache.delete(path);
      return;
    }
    const file: SnapshotFile = {
      path,
      kind: written.kind,
      bytes: written.bytes,
      fingerprint: null,
      formatVersion: written.check.formatVersion,
      status: written.check.status,
      value: written.check.value,
      issues: written.check.issues,
    };
    // Read back once at the next refresh, which compares the bytes (layer 9 of `write.ts`).
    cache.set(path, { file, fingerprint: null, unsettled: true, brokenLink: null });
  };

  return { request, wrote };
}
