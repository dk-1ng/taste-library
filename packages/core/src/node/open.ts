import { createHash } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import { FORMAT_REGISTRY, type FormatRegistry } from "../format.js";
import type { Snapshot } from "../validation/library.js";
import { readLibraryFileBytes } from "./read-file.js";
import { createRefresher, type StatFn } from "./refresh.js";
import { type Build, type LibraryWriteOptions, runWrite, type WriteResult } from "./write.js";

/**
 * Opening a library and keeping it fresh (docs/design.md section 3, "Core modules and API";
 * section 4, "Reading library files", "I/O", and "Index"). The listing, the stats and the reads
 * are in `node/` because they touch the operating system; every check is in the pure modules.
 */

export interface OpenOptions {
  /** The format registry; the production one by default, tests pass one with another version. */
  registry?: FormatRegistry;
  /** SHA-256 of bytes as lowercase hex, for `proposal-stale`; `node:crypto` by default. */
  sha256?: (bytes: Uint8Array) => string;
  /** Replaces `readdir` (tests inject listing failures that cannot be made portably). */
  readdir?: typeof readdir;
  /** Replaces the `stat` of a refresh (tests count calls and inject fingerprints). */
  stat?: StatFn;
  /** The system clock in milliseconds, read right after a file is stat'd; tests make files settled or not. */
  statClock?: () => number;
  /** Replaces the reading of a library file (tests count reads). */
  readFile?: typeof readLibraryFileBytes;
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
   * A snapshot of the library as it is now, refreshed first (docs/design.md section 4, "Index"):
   * every call lists the folders and stats every file, and reads again only what changed or is
   * unsettled. With nothing changed it returns the same snapshot object.
   */
  snapshot(): Promise<SnapshotResult>;
  /**
   * Writes one library file through the pipeline (docs/design.md section 4, "Writing library
   * files"): `build` receives the fresh, gated snapshot and returns the plan. Writes through one
   * handle run one at a time, in order; across processes the optimistic check decides.
   */
  write(build: Build, options?: LibraryWriteOptions): Promise<WriteResult>;
}

export type OpenResult = { ok: true; library: Library } | OpenFailure;

const sha256Hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/**
 * Opens the library in `root`: lists its folders, reads every file once, checks them and returns
 * a handle. `not-a-library` (no `library.json`) and `unreadable-folder` are results, never thrown;
 * the command line turns them into exit 2 (format-spec §16.1).
 */
export async function openLibrary(root: string, options: OpenOptions = {}): Promise<OpenResult> {
  const registry = options.registry ?? FORMAT_REGISTRY;
  const sha256 = options.sha256 ?? sha256Hex;
  const refresher = createRefresher({
    root,
    registry,
    sha256,
    list: options.readdir ?? readdir,
    stat: options.stat ?? stat,
    statClock: options.statClock ?? Date.now,
    readFile: options.readFile ?? readLibraryFileBytes,
  });
  const first = await refresher.request();
  if (!first.ok) return first;
  const snapshot = (): Promise<SnapshotResult> => refresher.request();
  let queue: Promise<unknown> = Promise.resolve();
  return {
    ok: true,
    library: {
      snapshot,
      write(build, writeOptions) {
        const run = queue.then(() =>
          runWrite(
            { root, registry, sha256, snapshot, wrote: refresher.wrote },
            build,
            writeOptions,
          ),
        );
        queue = run.catch(() => undefined);
        return run;
      },
    },
  };
}
