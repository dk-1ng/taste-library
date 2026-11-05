import { constants } from "node:fs";
import * as fsPromises from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { randomPart, type RandomSource } from "../ids/random.js";

/**
 * Atomic replacement of one library file with the optimistic write-conflict check
 * (docs/design.md section 4 "Writing library files"; format-spec section 5). This is the low-level
 * primitive: it knows nothing about validation, snapshots or the migration backup.
 *
 * Expected failures are returned, never thrown. An exception without an `errno` code (a bug, or the
 * tests' `SimulatedCrash`) propagates with nothing cleaned up, like a process that dies there.
 */

/** The subset of `node:fs/promises` the primitive needs; tests wrap it to inject failures. */
export type FileSystem = Pick<
  typeof fsPromises,
  "open" | "readFile" | "rename" | "unlink" | "mkdir" | "rmdir" | "stat"
>;

export const realFileSystem: FileSystem = fsPromises;

/** Bytes the writer read, or `"absent"` when the file did not exist. */
export type Expected = Uint8Array | "absent";

export interface IoFailure {
  code: "io-error";
  operation: string;
  file: string;
  errno: string;
  message: string;
}

export type WriteOutcome =
  | {
      status: "done";
      /** Folders this call created and left in place, outermost first. */
      createdFolders: string[];
    }
  /** The target differs from `expected`; the other writer's bytes were left alone. */
  | { status: "write-conflict"; file: string }
  | { status: "failed"; failure: IoFailure };

export interface WriteOptions {
  /** The exact bytes read before, or `"absent"`. */
  expected: Expected;
  /** `fsync` the folder after the rename or deletion, except on Windows (design section 4 "Durability"). */
  durable?: boolean;
  /** Name used in results, normally the path relative to the library. Default: the target path. */
  file?: string;
  fs?: FileSystem;
  /** For the Windows retry path to be tested everywhere. Default: `process.platform`. */
  platform?: NodeJS.Platform;
  random?: RandomSource;
  /** Milliseconds, monotonic. Default: `performance.now`. */
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  /** Called at named steps (`temp-written`, `before-rename`, `before-unlink`); tests inject changes and crashes. */
  at?: (point: string) => void | Promise<void>;
}

const RETRY_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);
const RETRY_WINDOW_MS = 2000;
const FIRST_WAIT_MS = 10;
const MAX_WAIT_MS = 250;

/** Thrown inside the module to end the operation with a result. */
class Stop {
  readonly outcome: WriteOutcome;
  constructor(outcome: WriteOutcome) {
    this.outcome = outcome;
  }
}

function errnoOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  // No errno code, or a Node argument error (ERR_*): a bug, not an I/O failure.
  return typeof code === "string" && !code.startsWith("ERR_") ? code : undefined;
}

interface Context {
  target: string;
  file: string;
  fs: FileSystem;
  platform: NodeJS.Platform;
  now: () => number;
  sleep: (milliseconds: number) => Promise<void>;
  at: (point: string) => void | Promise<void>;
}

function context(target: string, options: WriteOptions): Context {
  return {
    target,
    file: options.file ?? target,
    fs: options.fs ?? realFileSystem,
    platform: options.platform ?? process.platform,
    now: options.now ?? (() => performance.now()),
    sleep: options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    at: options.at ?? (() => undefined),
  };
}

function failure(ctx: Context, operation: string, error: unknown, errno: string): Stop {
  const detail = error instanceof Error ? error.message : String(error);
  return new Stop({
    status: "failed",
    failure: { code: "io-error", operation, file: ctx.file, errno, message: detail },
  });
}

/** Runs a file-system call; an error with an errno becomes a result, any other error propagates. */
async function io<T>(ctx: Context, operation: string, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    const errno = errnoOf(error);
    if (errno === undefined) throw error;
    throw failure(ctx, operation, error, errno);
  }
}

/** Reads the target again and compares it with what the writer started from. */
async function checkTarget(ctx: Context, expected: Expected): Promise<void> {
  let current: Uint8Array | "absent";
  try {
    current = await ctx.fs.readFile(ctx.target);
  } catch (error) {
    const errno = errnoOf(error);
    if (errno === undefined) throw error;
    if (errno !== "ENOENT") throw failure(ctx, "read", error, errno);
    current = "absent";
  }
  const same =
    expected === "absent" || current === "absent"
      ? expected === current
      : Buffer.compare(expected, current) === 0;
  if (!same) throw new Stop({ status: "write-conflict", file: ctx.file });
}

/**
 * Runs `call` (a rename or an unlink). On Windows, `EPERM`, `EACCES` and `EBUSY` are retried until
 * two seconds have passed since the first failure, waiting 10 ms and doubling up to 250 ms, with the
 * optimistic check repeated before each retry. Elsewhere they are real errors and never retried.
 */
async function withRetries(
  ctx: Context,
  operation: string,
  expected: Expected,
  call: () => Promise<void>,
): Promise<void> {
  let firstFailure: number | undefined;
  let wait = FIRST_WAIT_MS;
  for (;;) {
    try {
      await call();
      return;
    } catch (error) {
      const errno = errnoOf(error);
      if (errno === undefined) throw error;
      if (ctx.platform !== "win32" || !RETRY_CODES.has(errno)) {
        throw failure(ctx, operation, error, errno);
      }
      firstFailure ??= ctx.now();
      if (ctx.now() - firstFailure >= RETRY_WINDOW_MS) throw failure(ctx, operation, error, errno);
    }
    await ctx.sleep(wait);
    wait = Math.min(wait * 2, MAX_WAIT_MS);
    await checkTarget(ctx, expected);
  }
}

/** Creates the missing folders above `folder`, one level at a time, and returns the ones it made. */
async function createMissingFolders(ctx: Context, folder: string): Promise<string[]> {
  const missing: string[] = [];
  let current = folder;
  for (;;) {
    try {
      await ctx.fs.stat(current);
      break;
    } catch (error) {
      const errno = errnoOf(error);
      if (errno === undefined) throw error;
      if (errno !== "ENOENT") throw failure(ctx, "stat", error, errno);
      missing.unshift(current);
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  const created: string[] = [];
  for (const path of missing) {
    try {
      await ctx.fs.mkdir(path);
      created.push(path);
    } catch (error) {
      const errno = errnoOf(error);
      if (errno === undefined) throw error;
      // Another writer made it first: fine, but it is not ours to remove.
      if (errno !== "EEXIST") {
        await removeFolders(ctx, created);
        throw failure(ctx, "mkdir", error, errno);
      }
    }
  }
  return created;
}

/** Removes folders this call created, innermost first; one that is not empty (another writer filled it) stays. */
async function removeFolders(ctx: Context, folders: string[]): Promise<void> {
  for (const folder of [...folders].reverse()) {
    try {
      await ctx.fs.rmdir(folder);
    } catch (error) {
      if (errnoOf(error) === undefined) throw error;
    }
  }
}

async function flushFolder(ctx: Context, folder: string, durable: boolean | undefined) {
  if (durable !== true || ctx.platform === "win32") return;
  await io(ctx, "sync-folder", async () => {
    const handle = await ctx.fs.open(folder, constants.O_RDONLY);
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  });
}

/**
 * Writes `bytes` to a temporary file next to `target` (`.<name>.tmp-<8 characters>`, created
 * exclusively, flushed), re-reads `target`, and renames over it, or ends with `write-conflict`
 * when it no longer holds `expected`. Missing parent folders are created first, and removed again
 * on a refusal or failure.
 */
export async function replaceFile(
  target: string,
  bytes: Uint8Array,
  options: WriteOptions,
): Promise<WriteOutcome> {
  const ctx = context(target, options);
  const folder = dirname(target);
  const temporary = join(folder, `.${basename(target)}.tmp-${randomPart(8, options.random)}`);
  let createdFolders: string[] = [];
  let temporaryExists = false;
  try {
    createdFolders = await createMissingFolders(ctx, folder);
    await io(ctx, "write", async () => {
      const handle = await ctx.fs.open(temporary, "wx");
      temporaryExists = true;
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
    });
    await ctx.at("temp-written");
    await ctx.at("before-rename");
    await checkTarget(ctx, options.expected);
    await withRetries(ctx, "rename", options.expected, () => ctx.fs.rename(temporary, target));
    temporaryExists = false;
    await flushFolder(ctx, folder, options.durable);
    return { status: "done", createdFolders };
  } catch (error) {
    if (!(error instanceof Stop)) throw error;
    // Cleanup runs only here, on result paths (design section 4 "Cleanup only on result paths").
    if (temporaryExists) await ctx.fs.unlink(temporary).catch(() => undefined);
    await removeFolders(ctx, createdFolders);
    return error.outcome;
  }
}

/** Removes `target` with the same optimistic check: `write-conflict` when it no longer holds `expected`. */
export async function removeFile(
  target: string,
  options: WriteOptions & { expected: Uint8Array },
): Promise<WriteOutcome> {
  const ctx = context(target, options);
  try {
    await ctx.at("before-unlink");
    await checkTarget(ctx, options.expected);
    await withRetries(ctx, "unlink", options.expected, () => ctx.fs.unlink(target));
    await flushFolder(ctx, dirname(target), options.durable);
    return { status: "done", createdFolders: [] };
  } catch (error) {
    if (!(error instanceof Stop)) throw error;
    return error.outcome;
  }
}
