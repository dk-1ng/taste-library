import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat } from "node:fs/promises";
import { dirname } from "node:path";
import { FORMAT_REGISTRY, type FormatRegistry } from "../format.js";
import { type MigrationPlan, planMigration } from "../migrations/plan.js";
import { type Issue, makeIssue } from "../validation/issue.js";
import type { Snapshot } from "../validation/library.js";
import {
  BACKUP,
  type BackupManifest,
  backupFileBytes,
  backupPresent,
  COPIES,
  copyPathOf,
  isSafeRelativePath,
  MANIFEST_FILE,
  manifestSchema,
  OWNER_FILE,
  ownerSchema,
  pathIn,
  TOOL_FOLDER,
} from "./migration-backup.js";
import type { Library } from "./open.js";
import type { Written } from "./refresh.js";
import {
  type Expected,
  type FileSystem,
  type IoFailure,
  realFileSystem,
  removeFile,
  replaceFile,
  type WriteOptions,
  type WriteOutcome,
} from "./replace-file.js";
import type { Notice, WriteFailure } from "./write.js";

/**
 * Migrating a library on disk (format-spec §15.3; docs/design.md section 4, "Format versions",
 * "Write gate" and "`tastelib migrate`"): the dry run, which plans in memory and only reads, and
 * the runner, which the write gate calls before a write to an older or mixed library. Both plan
 * with the same planner as the snapshot's migrated view (`migrations/plan.ts`, steps 1 to 3), so
 * the three never disagree.
 */

export interface DryRunOptions {
  /** The registry the library was opened with; the production one by default. */
  registry?: FormatRegistry;
  /** SHA-256 of bytes as lowercase hex, for the checks across files; `node:crypto` by default. */
  sha256?: (bytes: Uint8Array) => string;
  /** Replaces the `lstat` that looks for the migration backup (tests inject failures). */
  lstat?: (path: string) => Promise<unknown>;
}

/**
 * What a dry run gives: the plan (`current`, `blocked` with the issues that block it, or `ready`
 * with the files that would change, be added and be removed); `backup` when a migration backup
 * exists, since the files may then be half-migrated and no plan is given; or `failed`, when the
 * folder is no longer a readable library or the backup cannot be looked for (`io-error`).
 */
export type DryRunResult =
  | MigrationPlan
  | { status: "backup" }
  | { status: "failed"; failure: WriteFailure };

const sha256Hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

function errnoOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && !code.startsWith("ERR_") ? code : undefined;
}

/**
 * Plans the migration of the library in `root`, opened as `library`, without writing anything,
 * not even `.tastelib/`: no gate, no recovery. Expected failures are results, never thrown.
 */
export async function dryRunMigration(
  root: string,
  library: Pick<Library, "snapshot">,
  options: DryRunOptions = {},
): Promise<DryRunResult> {
  const registry = options.registry ?? FORMAT_REGISTRY;
  const result = await library.snapshot();
  if (!result.ok) {
    return { status: "failed", failure: { code: result.code, message: result.message } };
  }
  try {
    if (await backupPresent(root, options.lstat ?? lstat)) return { status: "backup" };
  } catch (error) {
    const errno = errnoOf(error);
    if (errno === undefined) throw error;
    return {
      status: "failed",
      failure: {
        code: "io-error",
        operation: "lstat",
        file: BACKUP,
        errno,
        message: `The migration backup folder cannot be looked for (${errno}).`,
      },
    };
  }
  return planMigration(registry, result.snapshot, options.sha256 ?? sha256Hex);
}

/** What the runner needs from the library handle. */
export interface RunnerContext {
  root: string;
  registry: FormatRegistry;
  sha256: (bytes: Uint8Array) => string;
  /** Written to `owner.json` with `pid` (docs/design.md section 15, "Crash points"). */
  hostName: string;
  pid: number;
  /**
   * Told after each library file the runner, or its cleanup, wrote or deleted, as the pipeline's
   * layer 9 is.
   */
  wrote?: (path: string, written: Written) => void;
}

/**
 * The runner's options: those of the replace primitive it writes with, without what it sets for
 * each file (it always writes durably and never checks for the backup, which is its own), and
 * the clock of the claim time. Besides the replace primitive's own points, `at` is called with
 * `before-claim`, `claimed`, `owner-written`, `copied:<path>`, `manifest-written`,
 * `wrote:<path>`, `deleted:<path>`, `library-json-written`, `done-written`,
 * `backup-deleted:<path in the backup>` (`files/<path>` for each copy, then `manifest.json`) and
 * `owner-deleted`, in that order. A cleanup (docs/design.md section 4, "Migration runner
 * failures") calls it with `restored:<path>` after each file it restored from the backup and
 * `removed:<path>` after each added file it removed, then with the points of the backup's
 * deletion. `at` may return a promise, so a test can pause a run at a point.
 */
export interface RunnerOptions
  extends Omit<WriteOptions, "expected" | "root" | "file" | "conflictCheck" | "durable"> {
  /** The time of the claim, written to `owner.json`. Default: the system clock. */
  clock?: () => Date;
}

/** The lists of a migration that ran to the end. */
export interface Migrated {
  status: "migrated";
  from: number;
  to: number;
  /** Library files whose value changed, sorted by path. */
  changed: readonly string[];
  /** Library files the migration added, sorted by path. */
  added: readonly string[];
  /** Library files the migration removed, sorted by path. */
  removed: readonly string[];
}

/** A file as it was at step 1, which a cleanup puts back: its bytes and their check. */
type Restorable = Exclude<Written, null>;

/** One library file the runner replaced, deleted or added in step 5, and how a cleanup undoes it. */
type Undo =
  | { action: "replaced"; path: string; wrote: Uint8Array; backup: Restorable }
  | { action: "deleted"; path: string; backup: Restorable }
  | { action: "added"; path: string; wrote: Uint8Array };

/**
 * What a migration of this process has on disk, kept in memory only and updated as it is undone
 * and deleted (docs/design.md section 4, "Migration runner failures"). When the runner's cleanup
 * fails too, the handle keeps it as its pending cleanup and resumes it before its next write
 * ({@link resumeCleanup}). Its paths come from the plan and the format's constants, never from the
 * disk.
 */
export interface PendingCleanup {
  /** The exact bytes of the `owner.json` this run wrote; `null` once it is deleted. */
  owner: Uint8Array | null;
  /** The copies still in the backup, by library path, with their bytes. */
  copies: Map<string, Uint8Array>;
  /** Every library path the run copied or meant to copy, so their folders in the backup are removed. */
  copyPaths: readonly string[];
  /** The bytes of `manifest.json` on disk, or `null` when there is none. */
  manifest: Uint8Array | null;
  /** The step-5 changes left to undo, in the order they were made; empty once undone, or at `done`. */
  undo: Undo[];
  /** Folders step 5 created, outermost first; removed again when left empty by the undo. */
  createdFolders: string[];
  /** Whether this run created `.tastelib/`, removed again when the cleanup leaves it empty. */
  createdToolFolder: boolean;
}

/**
 * What the runner gives: `current` (nothing to migrate, nothing written), `blocked` (the migration
 * cannot run, format-spec §15.3 steps 1 and 3; nothing written, not even `.tastelib/`),
 * `migrated`, or a stop: `refused` (`write-conflict`) or `failed` (`io-error`), with the
 * `migrated` notice when the manifest was already marked `done` (docs/design.md section 3, "A
 * write result"). A stop has cleaned up after itself; `pending` is set when that cleanup failed
 * too and the backup stays, owned by this process.
 */
export type RunnerResult =
  | { status: "current" }
  | { status: "blocked"; issues: readonly Issue[] }
  | Migrated
  | { status: "refused"; issues: Issue[]; notice: Notice | null; pending: PendingCleanup | null }
  | {
      status: "failed";
      failure: IoFailure;
      notice: Notice | null;
      pending: PendingCleanup | null;
    };

/** A stop, before or during a cleanup: a refusal or a failure, with no absolute path. */
type Stop = { status: "refused"; issues: Issue[] } | { status: "failed"; failure: IoFailure };

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** A failure of the runner's own: the file is named relative to the library, never absolutely. */
function ioFailure(operation: string, file: string, errno: string): IoFailure {
  return {
    code: "io-error",
    operation,
    file,
    errno,
    message: `The migration could not ${operation} ${file} (${errno}).`,
  };
}

/** A stop of the replace primitive, as the runner reports it, its message without the absolute path. */
function stopOf(outcome: Exclude<WriteOutcome, { status: "done" }>): Stop {
  if (outcome.status === "write-conflict") {
    return { status: "refused", issues: [conflictIssue(outcome.file)] };
  }
  const { operation, file, errno } = outcome.failure;
  return { status: "failed", failure: ioFailure(operation, file, errno) };
}

function conflictIssue(file: string): Issue {
  return makeIssue(
    "write-conflict",
    file,
    null,
    "The file changed on disk while the library was being migrated, so the migration stopped. Read the library again and retry, or see `tastelib doctor`.",
  );
}

/** Flushes a folder, so the entries renamed, created or removed in it survive a power cut. */
async function flushFolder(fs: FileSystem, folder: string): Promise<void> {
  const handle = await fs.open(folder, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Removes an empty folder; an error with an errno (not there, not empty) is left as it is. */
async function removeEmptyFolder(fs: FileSystem, folder: string): Promise<void> {
  try {
    await fs.rmdir(folder);
  } catch (error) {
    if (errnoOf(error) === undefined) throw error;
  }
}

type Bounded =
  | { status: "bytes"; bytes: Uint8Array }
  | { status: "absent" }
  /** Not a regular file, or larger than the limit. */
  | { status: "other" }
  | { status: "failed"; errno: string };

/**
 * Reads `target` when it is a regular file of at most `limit` bytes. The size is checked first, on
 * the same handle, so a file that grew huge is never read; at most one byte more than the limit is
 * read, so a file that grew after the stat is `other` too.
 */
async function readBounded(fs: FileSystem, target: string, limit: number): Promise<Bounded> {
  try {
    // Non-blocking, as the reader does: a FIFO at the path must not hang the open.
    const handle = await fs.open(target, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > limit) return { status: "other" };
      const buffer = new Uint8Array(limit + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      if (length > limit) return { status: "other" };
      return { status: "bytes", bytes: buffer.slice(0, length) };
    } finally {
      await handle.close();
    }
  } catch (error) {
    const errno = errnoOf(error);
    if (errno === undefined) throw error;
    if (errno === "ENOENT") return { status: "absent" };
    return { status: "failed", errno };
  }
}

/** Whether the change reached the disk: done, or failed only at the folder flush after it (applied). */
const reached = (
  outcome: WriteOutcome,
): outcome is Exclude<WriteOutcome, { status: "write-conflict" }> =>
  outcome.status === "done" || (outcome.status === "failed" && outcome.applied);

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean =>
  a.byteLength === b.byteLength && a.every((byte, index) => byte === b[index]);

type ReadBack =
  | { status: "same"; bytes: Uint8Array }
  | { status: "changed" }
  | { status: "failed"; errno: string };

/**
 * Reads `target` from disk again and compares it with the bytes step 1 read. A file that
 * disappeared, grew or is no longer a regular file changed too.
 */
async function readBack(fs: FileSystem, target: string, expected: Uint8Array): Promise<ReadBack> {
  const read = await readBounded(fs, target, expected.byteLength);
  if (read.status === "failed") return read;
  if (read.status === "bytes" && sameBytes(read.bytes, expected)) {
    return { status: "same", bytes: read.bytes };
  }
  return { status: "changed" };
}

/** The folders under the backup's `files/` that hold the copies, deepest first, `files/` last. */
function copyFolders(copied: readonly string[]): string[] {
  const folders = new Set<string>();
  for (const path of copied) {
    const names = path.split("/");
    for (let depth = 1; depth < names.length; depth++) {
      folders.add(`${COPIES}/${names.slice(0, depth).join("/")}`);
    }
  }
  const depthOf = (folder: string) => folder.split("/").length;
  return [
    ...[...folders].sort((a, b) => depthOf(b) - depthOf(a) || compareText(a, b)),
    ...(copied.length > 0 ? [COPIES] : []),
  ];
}

/** What a cleanup needs: where, through what, and whom to tell about the library files it changes. */
interface CleanupContext {
  root: string;
  fs: FileSystem;
  platform: NodeJS.Platform;
  at: (point: string) => void | Promise<void>;
  /** The replace primitive's options that the cleanup passes through (randomness, clocks, sleep, `at`). */
  primitive: Omit<RunnerOptions, "clock">;
  wrote?: (path: string, written: Written) => void;
}

/** The replace primitive's options for one file of the cleanup. */
function optionsFor(
  ctx: CleanupContext,
  file: string,
  expected: Expected,
  durable: boolean,
): WriteOptions {
  return {
    ...ctx.primitive,
    fs: ctx.fs,
    platform: ctx.platform,
    root: ctx.root,
    durable,
    file,
    expected,
  };
}

/** Where a file of the undo list stands in a resumed cleanup. */
type UndoState = "to-undo" | "undone" | "other";

/**
 * The state of a file of the undo list, in the two states a resumed cleanup accepts
 * (docs/design.md section 4, "Migration runner failures"): a replaced file holds the runner's bytes
 * (to restore) or the backup's (restored); a deleted file is absent (to restore) or holds the
 * backup's bytes (restored); an added file holds the runner's bytes (to remove) or is absent
 * (removed). Anything else is `other`.
 */
async function undoStateOf(
  ctx: CleanupContext,
  entry: Undo,
): Promise<UndoState | { errno: string }> {
  const limit = Math.max(
    entry.action === "deleted" ? 0 : entry.wrote.byteLength,
    entry.action === "added" ? 0 : entry.backup.bytes.byteLength,
  );
  const read = await readBounded(ctx.fs, pathIn(ctx.root, entry.path), limit);
  if (read.status === "failed") return { errno: read.errno };
  const holds = (bytes: Uint8Array): boolean =>
    read.status === "bytes" && sameBytes(read.bytes, bytes);
  switch (entry.action) {
    case "replaced":
      return holds(entry.wrote) ? "to-undo" : holds(entry.backup.bytes) ? "undone" : "other";
    case "deleted":
      return read.status === "absent" ? "to-undo" : holds(entry.backup.bytes) ? "undone" : "other";
    case "added":
      return holds(entry.wrote) ? "to-undo" : read.status === "absent" ? "undone" : "other";
  }
}

/**
 * Undoes the step-5 changes of `left`, in the order they were made: each replaced or deleted file
 * is restored from the backup, checked first against the bytes the runner wrote (or against its
 * absence), and each added file is removed, checked the same way, every one durably. A resumed
 * cleanup first checks every file and refuses before changing anything when one is in a state it
 * does not accept; a file it finds already undone has its folder flushed, since the interrupted
 * cleanup may have stopped before that flush. Then the folders step 5 created are removed when
 * empty. Returns `null` once everything is undone.
 */
async function undoChanges(
  ctx: CleanupContext,
  left: PendingCleanup,
  resumed: boolean,
): Promise<Stop | null> {
  const states: UndoState[] = [];
  if (resumed) {
    for (const entry of left.undo) {
      const state = await undoStateOf(ctx, entry);
      if (typeof state === "object") {
        return { status: "failed", failure: ioFailure("read", entry.path, state.errno) };
      }
      if (state === "other") {
        const issue = makeIssue(
          "write-conflict",
          entry.path,
          null,
          "The file changed after a migration of this process stopped, so its cleanup cannot finish; the migration backup was kept. See `tastelib doctor --resolve-migration`.",
        );
        return { status: "refused", issues: [issue] };
      }
      states.push(state);
    }
  }
  for (const [index, entry] of left.undo.entries()) {
    const target = pathIn(ctx.root, entry.path);
    if (states[index] === "undone") {
      if (ctx.platform === "win32") continue;
      try {
        await flushFolder(ctx.fs, dirname(target));
      } catch (error) {
        const errno = errnoOf(error);
        if (errno === undefined) throw error;
        if (errno !== "ENOENT") {
          return { status: "failed", failure: ioFailure("sync-folder", entry.path, errno) };
        }
      }
      continue;
    }
    const outcome =
      entry.action === "added"
        ? await removeFile(target, {
            ...optionsFor(ctx, entry.path, entry.wrote, true),
            expected: entry.wrote,
          })
        : await replaceFile(
            target,
            entry.backup.bytes,
            optionsFor(ctx, entry.path, entry.action === "replaced" ? entry.wrote : "absent", true),
          );
    if (reached(outcome)) {
      ctx.wrote?.(entry.path, entry.action === "added" ? null : entry.backup);
    }
    if (outcome.status !== "done") return stopOf(outcome);
    await ctx.at(`${entry.action === "added" ? "removed" : "restored"}:${entry.path}`);
  }
  for (const folder of [...left.createdFolders].reverse()) await removeEmptyFolder(ctx.fs, folder);
  left.undo = [];
  left.createdFolders = [];
  return null;
}

/**
 * Deletes the backup in the order of format-spec §15.3 step 7: the copies and the manifest, the
 * copies' folders, `owner.json` last, then the folder. Each file is checked against the bytes this
 * run wrote, and forgotten once deleted, so a deletion that stopped can be run again. Nothing here
 * needs to be durable: a backup marked `done` is deleted by recovery whatever is left of it
 * (format-spec §15.3, case 5), and any other is deleted only once every library file this run
 * changed is back, durably, so what recovery would do with what is left of it changes nothing.
 */
async function deleteBackup(ctx: CleanupContext, left: PendingCleanup): Promise<Stop | null> {
  const remove = async (file: string, expected: Uint8Array): Promise<Stop | null> => {
    const outcome = await removeFile(pathIn(ctx.root, file), {
      ...optionsFor(ctx, file, expected, false),
      expected,
    });
    return outcome.status === "done" ? null : stopOf(outcome);
  };
  for (const [path, bytes] of [...left.copies]) {
    const stopped = await remove(copyPathOf(path), bytes);
    if (stopped !== null) return stopped;
    left.copies.delete(path);
    await ctx.at(`backup-deleted:files/${path}`);
  }
  if (left.manifest !== null) {
    const stopped = await remove(MANIFEST_FILE, left.manifest);
    if (stopped !== null) return stopped;
    left.manifest = null;
    await ctx.at("backup-deleted:manifest.json");
  }
  for (const folder of copyFolders(left.copyPaths)) {
    try {
      await ctx.fs.rmdir(pathIn(ctx.root, folder));
    } catch (error) {
      const errno = errnoOf(error);
      if (errno === undefined) throw error;
      // A folder no copy was written to, or that a stopped deletion already removed.
      if (errno !== "ENOENT")
        return { status: "failed", failure: ioFailure("rmdir", folder, errno) };
    }
  }
  if (left.owner !== null) {
    const stopped = await remove(OWNER_FILE, left.owner);
    if (stopped !== null) return stopped;
    left.owner = null;
    await ctx.at("owner-deleted");
  }
  try {
    await ctx.fs.rmdir(pathIn(ctx.root, BACKUP));
  } catch (error) {
    const errno = errnoOf(error);
    if (errno === undefined) throw error;
    if (errno !== "ENOENT") return { status: "failed", failure: ioFailure("rmdir", BACKUP, errno) };
  }
  return null;
}

/**
 * The cleanup of a migration that stopped after `owner.json` was written (docs/design.md section
 * 4, "Migration runner failures"): it undoes what is left of step 5, deletes the backup and then
 * the `.tastelib/` this run created, if it is empty. Returns `null` once done, or the stop that
 * ended it, with `left` updated to what is still on disk.
 */
async function cleanUp(
  ctx: CleanupContext,
  left: PendingCleanup,
  resumed: boolean,
): Promise<Stop | null> {
  const undone = await undoChanges(ctx, left, resumed);
  if (undone !== null) return undone;
  const deleted = await deleteBackup(ctx, left);
  if (deleted !== null) return deleted;
  if (left.createdToolFolder) await removeEmptyFolder(ctx.fs, pathIn(ctx.root, TOOL_FOLDER));
  return null;
}

/** The cleanup context of a run or a resumed cleanup with `options`. */
function cleanupContext(
  root: string,
  wrote: RunnerContext["wrote"],
  options: RunnerOptions,
): CleanupContext {
  const { clock: _clock, ...primitive } = options;
  return {
    root,
    fs: options.fs ?? realFileSystem,
    platform: options.platform ?? process.platform,
    at: options.at ?? (() => undefined),
    primitive,
    wrote,
  };
}

/** The message of a stop whose cleanup failed too, so the user knows the backup stayed. */
function backupKept(stop: Stop): Stop {
  const kept = " The migration backup was kept; see `tastelib doctor`.";
  if (stop.status === "failed") {
    return { ...stop, failure: { ...stop.failure, message: `${stop.failure.message}${kept}` } };
  }
  return {
    ...stop,
    issues: stop.issues.map((issue) => ({ ...issue, message: `${issue.message}${kept}` })),
  };
}

/**
 * Migrates the library on disk (format-spec §15.3): plans steps 1 to 3 from `snapshot` (the
 * gate's fresh snapshot), then claims `.tastelib/migration-backup/` with a non-recursive `mkdir`
 * (creating `.tastelib/` first), writes `owner.json`, copies every file it will change or delete,
 * each read again from disk and compared with its step-1 bytes, writes the manifest
 * `in-progress`, writes the files with `library.json` last, marks the manifest `done` and deletes
 * the backup, `owner.json` last. Every file of steps 4 to 6 is flushed before its rename and every
 * folder it touched after it (docs/design.md section 4, "Durability"; not on Windows).
 *
 * Expected failures are results, never thrown. A stop cleans up after itself before it returns,
 * only on these result paths (docs/design.md section 4, "Migration runner failures" and "Cleanup
 * only on result paths"): before `owner.json` exists it removes the empty claim; before the
 * manifest, it deletes the backup; with the manifest `in-progress`, it undoes, from the list it
 * keeps in memory, only what this run did, then deletes the backup; with the manifest `done`, it
 * deletes the backup and the library stays migrated. When that cleanup fails too, the backup stays,
 * owned by this process, and the result's `pending` says what is left. Any other exception (a bug,
 * or a test's simulated crash) propagates with nothing cleaned up.
 *
 * @throws when a step gives a path that is not a safe relative path of the format (a step bug,
 *   docs/design.md section 14), or when the injected owner is not valid.
 */
export async function runMigration(
  context: RunnerContext,
  snapshot: Snapshot,
  options: RunnerOptions = {},
): Promise<RunnerResult> {
  const plan = planMigration(context.registry, snapshot, context.sha256);
  if (plan.status === "current") return plan;
  if (plan.status === "blocked") return { status: "blocked", issues: plan.issues };
  for (const path of [...plan.changed, ...plan.added, ...plan.removed]) {
    if (!isSafeRelativePath(path)) {
      throw new Error(`The migration gave the path ${JSON.stringify(path)}, which is not safe.`);
    }
  }

  const { root } = context;
  const ctx = cleanupContext(root, context.wrote, options);
  const { fs, platform, at } = ctx;
  const owner = ownerSchema.parse({
    pid: context.pid,
    host: context.hostName,
    claimedAt: (options.clock?.() ?? new Date()).toISOString(),
  });
  const durably = (file: string, expected: Expected): WriteOptions =>
    optionsFor(ctx, file, expected, true);
  const entryOf = (path: string): Restorable => {
    const file = snapshot.files.get(path);
    if (file?.bytes === undefined || file.bytes === null)
      throw new Error(`"${path}" was never read.`);
    return {
      kind: file.kind,
      bytes: file.bytes,
      check: {
        status: file.status,
        formatVersion: file.formatVersion,
        value: file.value,
        issues: [...file.issues],
      },
    };
  };
  const before = (path: string): Uint8Array => entryOf(path).bytes;
  const durableFolders = platform !== "win32";
  const copied = [...plan.changed, ...plan.removed].sort(compareText);

  await at("before-claim");

  // 4. Claim: `.tastelib/` first, then the backup folder, which only one process can create.
  const toolFolder = pathIn(root, TOOL_FOLDER);
  const backupFolder = pathIn(root, BACKUP);
  let createdToolFolder = false;
  try {
    await fs.mkdir(toolFolder);
    createdToolFolder = true;
  } catch (error) {
    const errno = errnoOf(error);
    if (errno === undefined) throw error;
    if (errno !== "EEXIST") {
      return {
        status: "failed",
        failure: ioFailure("mkdir", TOOL_FOLDER, errno),
        notice: null,
        pending: null,
      };
    }
  }
  /** Ends a run stopped before `owner.json` exists: the claim is still empty and is removed. */
  const releaseClaim = async (stop: Stop): Promise<RunnerResult> => {
    await removeEmptyFolder(fs, backupFolder);
    if (createdToolFolder) await removeEmptyFolder(fs, toolFolder);
    return { ...stop, notice: null, pending: null };
  };
  try {
    await fs.mkdir(backupFolder);
  } catch (error) {
    const errno = errnoOf(error);
    if (errno === undefined) throw error;
    if (createdToolFolder) await removeEmptyFolder(fs, toolFolder);
    if (errno === "EEXIST") {
      const issue = makeIssue(
        "write-conflict",
        BACKUP,
        null,
        "Another migration claimed the backup folder first; nothing was written. Try again later, or see `tastelib doctor`.",
      );
      return { status: "refused", issues: [issue], notice: null, pending: null };
    }
    return {
      status: "failed",
      failure: ioFailure("mkdir", BACKUP, errno),
      notice: null,
      pending: null,
    };
  }
  // The claim's folder entries: the backup folder in `.tastelib/`, and `.tastelib/` in the
  // library folder when this run created it.
  if (durableFolders) {
    for (const [folder, name] of [
      [toolFolder, TOOL_FOLDER],
      ...(createdToolFolder ? [[root, "."] as const] : []),
    ] as const) {
      try {
        await flushFolder(fs, folder);
      } catch (error) {
        const errno = errnoOf(error);
        if (errno === undefined) throw error;
        return releaseClaim({
          status: "failed",
          failure: ioFailure("sync-folder", name, errno),
        });
      }
    }
  }
  await at("claimed");

  const ownerBytes = backupFileBytes(owner);
  const ownerWrite = await replaceFile(
    pathIn(root, OWNER_FILE),
    ownerBytes,
    durably(OWNER_FILE, "absent"),
  );
  // Without `owner.json` the claim is still empty and can be removed; with it (only its folder
  // flush failed), the backup is deleted like any other below.
  if (ownerWrite.status !== "done" && !(ownerWrite.status === "failed" && ownerWrite.applied)) {
    return releaseClaim(stopOf(ownerWrite));
  }

  // From here on, everything this run puts on disk is recorded, so a stop can undo it.
  const left: PendingCleanup = {
    owner: ownerBytes,
    copies: new Map(),
    copyPaths: copied,
    manifest: null,
    undo: [],
    createdFolders: [],
    createdToolFolder,
  };
  let notice: Notice | null = null;
  /** Ends a stopped run: cleans up, and keeps what is left when the cleanup fails too. */
  const stop = async (stopped: Stop): Promise<RunnerResult> => {
    const failed = await cleanUp(ctx, left, false);
    if (failed === null) return { ...stopped, notice, pending: null };
    return { ...backupKept(stopped), notice, pending: left.owner === null ? null : left };
  };
  if (ownerWrite.status !== "done") return stop(stopOf(ownerWrite));
  await at("owner-written");

  // The copies: every file that will change or be deleted, read from disk again after the claim.
  for (const path of copied) {
    const read = await readBack(fs, pathIn(root, path), before(path));
    if (read.status === "changed")
      return stop({ status: "refused", issues: [conflictIssue(path)] });
    if (read.status === "failed") {
      return stop({ status: "failed", failure: ioFailure("read", path, read.errno) });
    }
    const copy = copyPathOf(path);
    const written = await replaceFile(pathIn(root, copy), read.bytes, durably(copy, "absent"));
    if (reached(written)) {
      left.copies.set(path, read.bytes);
    }
    if (written.status !== "done") return stop(stopOf(written));
    await at(`copied:${path}`);
  }

  const manifest: BackupManifest = manifestSchema.parse({
    state: "in-progress",
    toVersion: plan.to,
    added: [...plan.added],
  });
  const inProgress = backupFileBytes(manifest);
  const manifestWrite = await replaceFile(
    pathIn(root, MANIFEST_FILE),
    inProgress,
    durably(MANIFEST_FILE, "absent"),
  );
  if (reached(manifestWrite)) {
    left.manifest = inProgress;
  }
  if (manifestWrite.status !== "done") return stop(stopOf(manifestWrite));
  await at("manifest-written");

  // 5. The changed and added files, then the deletions, and `library.json` last. Each file that
  //    reached the disk (a failed flush marked applied included) joins the undo list.
  const writeFile = async (path: string): Promise<RunnerResult | null> => {
    const bytes = plan.bytes.get(path);
    const file = plan.migrated.files.get(path);
    if (bytes === undefined || file === undefined) throw new Error(`"${path}" was not planned.`);
    const existed = snapshot.files.has(path);
    const outcome = await replaceFile(
      pathIn(root, path),
      bytes,
      durably(path, existed ? before(path) : "absent"),
    );
    if (reached(outcome)) {
      left.undo.push(
        existed
          ? { action: "replaced", path, wrote: bytes, backup: entryOf(path) }
          : { action: "added", path, wrote: bytes },
      );
      left.createdFolders.push(...outcome.createdFolders);
      context.wrote?.(path, {
        kind: file.kind,
        bytes,
        check: {
          status: file.status,
          formatVersion: file.formatVersion,
          value: file.value,
          issues: [...file.issues],
        },
      });
    }
    return outcome.status === "done" ? null : stop(stopOf(outcome));
  };
  const writes = [...plan.changed, ...plan.added]
    .filter((path) => path !== "library.json")
    .sort(compareText);
  for (const path of writes) {
    const stopped = await writeFile(path);
    if (stopped !== null) return stopped;
    await at(`wrote:${path}`);
  }
  for (const path of plan.removed) {
    const outcome = await removeFile(pathIn(root, path), {
      ...durably(path, "absent"),
      expected: before(path),
    });
    if (reached(outcome)) {
      left.undo.push({ action: "deleted", path, backup: entryOf(path) });
      context.wrote?.(path, null);
    }
    if (outcome.status !== "done") return stop(stopOf(outcome));
    await at(`deleted:${path}`);
  }
  if (plan.changed.includes("library.json")) {
    const stopped = await writeFile("library.json");
    if (stopped !== null) return stopped;
    await at("library-json-written");
  }

  // 6. The manifest marked `done`: from here on the library is migrated, and nothing is undone.
  const done = backupFileBytes({ ...manifest, state: "done" });
  const doneWrite = await replaceFile(
    pathIn(root, MANIFEST_FILE),
    done,
    durably(MANIFEST_FILE, inProgress),
  );
  if (reached(doneWrite)) {
    left.manifest = done;
    left.undo = [];
    left.createdFolders = [];
    notice = { code: "migrated", from: plan.from, to: plan.to };
  }
  if (doneWrite.status !== "done") return stop(stopOf(doneWrite));
  await at("done-written");

  // 7. Delete the backup, `owner.json` last; a deletion that stops is run again by the cleanup.
  const deleted = await deleteBackup(ctx, left);
  if (deleted !== null) return stop(deleted);
  return {
    status: "migrated",
    from: plan.from,
    to: plan.to,
    changed: plan.changed,
    added: plan.added,
    removed: plan.removed,
  };
}

/**
 * What resuming a pending cleanup gives: `done` (the backup is gone), `not-owner` (`owner.json`
 * no longer holds the bytes this process wrote, so the backup is not this process's to clean up and
 * nothing was done), or a stop that keeps the backup: `refused` (`write-conflict`, a file in a state
 * the cleanup does not accept) or `failed` (`io-error`).
 */
export type ResumeResult =
  | { status: "done" }
  | { status: "not-owner" }
  | { status: "refused"; issues: Issue[] }
  | { status: "failed"; failure: IoFailure };

/**
 * Resumes, as the owner, a cleanup that failed in this process (docs/design.md section 4,
 * "Migration runner failures"), before the handle's next write: only if `owner.json` still holds
 * exactly the bytes this process wrote. A file of the undo list is accepted in exactly two states
 * (still as the runner left it, or already undone); any other state refuses before anything is
 * changed, and the backup stays. `pending` is updated to what is left.
 */
export async function resumeCleanup(
  context: Pick<RunnerContext, "root" | "wrote">,
  pending: PendingCleanup,
  options: RunnerOptions = {},
): Promise<ResumeResult> {
  const ctx = cleanupContext(context.root, context.wrote, options);
  if (pending.owner === null) return { status: "not-owner" };
  const owner = await readBounded(ctx.fs, pathIn(ctx.root, OWNER_FILE), pending.owner.byteLength);
  if (owner.status === "failed") {
    return { status: "failed", failure: ioFailure("read", OWNER_FILE, owner.errno) };
  }
  if (owner.status !== "bytes" || !sameBytes(owner.bytes, pending.owner)) {
    return { status: "not-owner" };
  }
  return (await cleanUp(ctx, pending, true)) ?? { status: "done" };
}
