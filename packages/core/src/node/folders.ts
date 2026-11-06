import type { BigIntStats } from "node:fs";
import { lstat, realpath, stat } from "node:fs/promises";
import { dirname, join, parse } from "node:path";

/**
 * Folder identity and the Git walk (docs/design.md section 4, "Attaching a media folder",
 * "Comparing folders"). Nothing here compares paths as text where the file system can say which
 * folder a path really is.
 */

function errnoOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code !== "string" || code.startsWith("ERR_")) throw error;
  return code;
}

export type Located =
  | {
      status: "ok";
      /** The real path of `path`, or of its nearest existing ancestor. */
      real: string;
      /** `path` itself exists. */
      exists: boolean;
    }
  | { status: "failed"; errno: string };

/** Resolves symbolic links, junctions and mapped drives on `path`, or on the nearest ancestor that exists. */
export async function locate(path: string): Promise<Located> {
  let current = path;
  let exists = true;
  for (;;) {
    try {
      return { status: "ok", real: await realpath(current), exists };
    } catch (error) {
      const errno = errnoOf(error);
      if (errno !== "ENOENT") return { status: "failed", errno };
      const parent = dirname(current);
      if (parent === current) return { status: "ok", real: current, exists: false };
      current = parent;
      exists = false;
    }
  }
}

export type GitWalk =
  | { status: "found"; worktree: string }
  | { status: "none" }
  | { status: "failed"; errno: string };

/** Walks up from `path` (or its nearest existing ancestor, symbolic links resolved) looking for `.git`. */
export async function findGitWorkTree(path: string): Promise<GitWalk> {
  const located = await locate(path);
  if (located.status === "failed") return located;
  let current = located.real;
  const root = parse(current).root;
  for (;;) {
    try {
      await lstat(join(current, ".git"));
      return { status: "found", worktree: current };
    } catch (error) {
      const errno = errnoOf(error);
      if (errno !== "ENOENT" && errno !== "ENOTDIR") return { status: "failed", errno };
    }
    const parent = dirname(current);
    if (current === root || parent === current) return { status: "none" };
    current = parent;
  }
}

interface Identity {
  path: string;
  stats: BigIntStats;
}

async function identityOf(path: string): Promise<Identity | null> {
  try {
    return { path, stats: await stat(path, { bigint: true }) };
  } catch (error) {
    if (errnoOf(error) === "ENOENT") return null;
    throw error;
  }
}

function fold(path: string, platform: NodeJS.Platform): string {
  const normalized = path.normalize("NFC");
  return platform === "win32" || platform === "darwin" ? normalized.toLowerCase() : normalized;
}

/**
 * Whether two folders are the same: by `dev` and `ino`; where the file system gives no identity
 * (`ino` 0), by real path after `normalize("NFC")`, ignoring case on Windows and macOS.
 */
function sameFolder(a: Identity, b: Identity, platform: NodeJS.Platform): boolean {
  if (a.stats.ino !== 0n && b.stats.ino !== 0n) {
    return a.stats.dev === b.stats.dev && a.stats.ino === b.stats.ino;
  }
  return fold(a.path, platform) === fold(b.path, platform);
}

export type Containment =
  | { status: "ok"; contained: boolean }
  | { status: "failed"; errno: string };

/**
 * Whether `inner` is `outer` or inside it, decided on real folders: every folder from `inner`'s
 * real path (or its nearest existing ancestor) up to the root is compared with `outer` by identity.
 * `outer` must exist. With `stopAt` (a real folder), the walk ends there: `outer` is known to be
 * below it, so nothing above it can be `outer`.
 */
export async function isInside(
  inner: string,
  outer: string,
  platform: NodeJS.Platform = process.platform,
  stopAt?: string,
): Promise<Containment> {
  try {
    const located = await locate(inner);
    if (located.status === "failed") return located;
    const target = await identityOf(await realpath(outer));
    if (target === null) return { status: "ok", contained: false };
    const stop = stopAt === undefined ? null : await identityOf(stopAt);
    let current = located.real;
    for (;;) {
      const here = await identityOf(current);
      if (here !== null && sameFolder(here, target, platform)) {
        return { status: "ok", contained: true };
      }
      if (here !== null && stop !== null && sameFolder(here, stop, platform)) {
        return { status: "ok", contained: false };
      }
      const parent = dirname(current);
      if (parent === current) return { status: "ok", contained: false };
      current = parent;
    }
  } catch (error) {
    return { status: "failed", errno: errnoOf(error) };
  }
}
