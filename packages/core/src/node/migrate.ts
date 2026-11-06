import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat } from "node:fs/promises";
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
  /** Told after each library file the runner wrote or deleted, as the pipeline's layer 9 is. */
  wrote?: (path: string, written: Written) => void;
}

/**
 * The runner's options: those of the replace primitive it writes with, without what it sets for
 * each file (it always writes durably and never checks for the backup, which is its own), and
 * the clock of the claim time. Besides the replace primitive's own points, `at` is called with
 * `claimed`, `owner-written`, `copied:<path>`, `manifest-written`, `wrote:<path>`,
 * `deleted:<path>`, `library-json-written`, `done-written`, `backup-deleted:<path in the backup>`
 * (`files/<path>` for each copy, then `manifest.json`) and `owner-deleted`, in that order.
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

/**
 * What the runner gives: `current` (nothing to migrate, nothing written), `blocked` (the migration
 * cannot run, format-spec §15.3 steps 1 and 3; nothing written, not even `.tastelib/`),
 * `migrated`, or a stop: `refused` (`write-conflict`) or `failed` (`io-error`), with the
 * `migrated` notice when the manifest was already marked `done` (docs/design.md section 3, "A
 * write result").
 */
export type RunnerResult =
  | { status: "current" }
  | { status: "blocked"; issues: readonly Issue[] }
  | Migrated
  | { status: "refused"; issues: Issue[]; notice: Notice | null }
  | { status: "failed"; failure: IoFailure; notice: Notice | null };

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
function stopOf(
  outcome: Exclude<WriteOutcome, { status: "done" }>,
  notice: Notice | null,
): RunnerResult {
  if (outcome.status === "write-conflict") {
    return { status: "refused", issues: [conflictIssue(outcome.file)], notice };
  }
  const { operation, file, errno } = outcome.failure;
  return { status: "failed", failure: ioFailure(operation, file, errno), notice };
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

type ReadBack =
  | { status: "same"; bytes: Uint8Array }
  | { status: "changed" }
  | { status: "failed"; errno: string };

/**
 * Reads `target` from disk again and compares it with the bytes step 1 read. The size is compared
 * first, on the same handle, so a file that grew huge is never read; at most one byte more than
 * expected is read, so a file that grew after the stat is a change too.
 */
async function readBack(fs: FileSystem, target: string, expected: Uint8Array): Promise<ReadBack> {
  try {
    // Non-blocking, as the reader does: a FIFO at the path must not hang the open.
    const handle = await fs.open(target, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size !== expected.byteLength) return { status: "changed" };
      const buffer = new Uint8Array(expected.byteLength + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      const bytes = buffer.subarray(0, length);
      const same =
        length === expected.byteLength && bytes.every((byte, index) => byte === expected[index]);
      return same ? { status: "same", bytes } : { status: "changed" };
    } finally {
      await handle.close();
    }
  } catch (error) {
    const errno = errnoOf(error);
    if (errno === undefined) throw error;
    // A file that disappeared since step 1 changed too.
    if (errno === "ENOENT") return { status: "changed" };
    return { status: "failed", errno };
  }
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

/**
 * Migrates the library on disk (format-spec §15.3): plans steps 1 to 3 from `snapshot` (the
 * gate's fresh snapshot), then claims `.tastelib/migration-backup/` with a non-recursive `mkdir`
 * (creating `.tastelib/` first), writes `owner.json`, copies every file it will change or delete,
 * each read again from disk and compared with its step-1 bytes, writes the manifest
 * `in-progress`, writes the files with `library.json` last, marks the manifest `done` and deletes
 * the backup, `owner.json` last. Every file of steps 4 to 6 is flushed before its rename and every
 * folder it touched after it (docs/design.md section 4, "Durability"; not on Windows).
 *
 * Expected failures are results, never thrown. A stop before `owner.json` exists removes the
 * empty claim again; a stop after it leaves the backup as it is, owned by this process, which
 * recovery resolves once this process has ended (format-spec §15.3, cases 5 to 7).
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
  const { clock, ...primitive } = options;
  const fs = options.fs ?? realFileSystem;
  const platform = options.platform ?? process.platform;
  const at = options.at ?? (() => undefined);
  const owner = ownerSchema.parse({
    pid: context.pid,
    host: context.hostName,
    claimedAt: (clock?.() ?? new Date()).toISOString(),
  });
  const durably = (file: string, expected: Expected): WriteOptions => ({
    ...primitive,
    fs,
    platform,
    root,
    durable: true,
    file,
    expected,
  });
  const before = (path: string): Uint8Array => {
    const bytes = snapshot.files.get(path)?.bytes;
    if (bytes === undefined || bytes === null) throw new Error(`"${path}" was never read.`);
    return bytes;
  };
  const durableFolders = platform !== "win32";

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
      return { status: "failed", failure: ioFailure("mkdir", TOOL_FOLDER, errno), notice: null };
    }
  }
  /** Removes the claim while it is still empty (no `owner.json` was written). */
  const releaseClaim = async (): Promise<void> => {
    await removeEmptyFolder(fs, backupFolder);
    if (createdToolFolder) await removeEmptyFolder(fs, toolFolder);
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
      return { status: "refused", issues: [issue], notice: null };
    }
    return { status: "failed", failure: ioFailure("mkdir", BACKUP, errno), notice: null };
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
        await releaseClaim();
        return { status: "failed", failure: ioFailure("sync-folder", name, errno), notice: null };
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
  if (ownerWrite.status !== "done") {
    // Without `owner.json` the claim is still empty and can be removed; with it (only its folder
    // flush failed), it stays, owned by this process.
    if (!(ownerWrite.status === "failed" && ownerWrite.applied)) await releaseClaim();
    return stopOf(ownerWrite, null);
  }
  await at("owner-written");

  // The copies: every file that will change or be deleted, read from disk again after the claim.
  const copied = [...plan.changed, ...plan.removed].sort(compareText);
  const copies = new Map<string, Uint8Array>();
  for (const path of copied) {
    const read = await readBack(fs, pathIn(root, path), before(path));
    if (read.status === "changed") {
      return { status: "refused", issues: [conflictIssue(path)], notice: null };
    }
    if (read.status === "failed") {
      return { status: "failed", failure: ioFailure("read", path, read.errno), notice: null };
    }
    const copy = copyPathOf(path);
    const written = await replaceFile(pathIn(root, copy), read.bytes, durably(copy, "absent"));
    if (written.status !== "done") return stopOf(written, null);
    copies.set(path, read.bytes);
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
  if (manifestWrite.status !== "done") return stopOf(manifestWrite, null);
  await at("manifest-written");

  // 5. The changed and added files, then the deletions, and `library.json` last.
  const writeFile = async (path: string): Promise<RunnerResult | null> => {
    const bytes = plan.bytes.get(path);
    const file = plan.migrated.files.get(path);
    if (bytes === undefined || file === undefined) throw new Error(`"${path}" was not planned.`);
    const expected = snapshot.files.get(path)?.bytes ?? "absent";
    const outcome = await replaceFile(pathIn(root, path), bytes, durably(path, expected));
    if (outcome.status === "done" || (outcome.status === "failed" && outcome.applied)) {
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
    return outcome.status === "done" ? null : stopOf(outcome, null);
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
    if (outcome.status === "done" || (outcome.status === "failed" && outcome.applied)) {
      context.wrote?.(path, null);
    }
    if (outcome.status !== "done") return stopOf(outcome, null);
    await at(`deleted:${path}`);
  }
  if (plan.changed.includes("library.json")) {
    const stopped = await writeFile("library.json");
    if (stopped !== null) return stopped;
    await at("library-json-written");
  }

  // 6. The manifest marked `done`: from here on the library is migrated.
  const notice: Notice = { code: "migrated", from: plan.from, to: plan.to };
  const done = backupFileBytes({ ...manifest, state: "done" });
  const doneWrite = await replaceFile(
    pathIn(root, MANIFEST_FILE),
    done,
    durably(MANIFEST_FILE, inProgress),
  );
  if (doneWrite.status !== "done") {
    return stopOf(doneWrite, doneWrite.status === "failed" && doneWrite.applied ? notice : null);
  }
  await at("done-written");

  // 7. Delete the backup: the copies and the manifest, the copies' folders, `owner.json` last,
  //    then the folder. Nothing here needs to be durable: a backup marked `done` is deleted by
  //    recovery whatever is left of it (format-spec §15.3, case 5).
  const remove = async (file: string, expected: Uint8Array): Promise<RunnerResult | null> => {
    const outcome = await removeFile(pathIn(root, file), {
      ...primitive,
      fs,
      platform,
      durable: false,
      file,
      expected,
    });
    return outcome.status === "done" ? null : stopOf(outcome, notice);
  };
  for (const path of copied) {
    const stopped = await remove(copyPathOf(path), copies.get(path) as Uint8Array);
    if (stopped !== null) return stopped;
    await at(`backup-deleted:files/${path}`);
  }
  const manifestRemoved = await remove(MANIFEST_FILE, done);
  if (manifestRemoved !== null) return manifestRemoved;
  await at("backup-deleted:manifest.json");
  for (const folder of copyFolders(copied)) {
    try {
      await fs.rmdir(pathIn(root, folder));
    } catch (error) {
      const errno = errnoOf(error);
      if (errno === undefined) throw error;
      return { status: "failed", failure: ioFailure("rmdir", folder, errno), notice };
    }
  }
  const ownerRemoved = await remove(OWNER_FILE, ownerBytes);
  if (ownerRemoved !== null) return ownerRemoved;
  await at("owner-deleted");
  try {
    await fs.rmdir(backupFolder);
  } catch (error) {
    const errno = errnoOf(error);
    if (errno === undefined) throw error;
    return { status: "failed", failure: ioFailure("rmdir", BACKUP, errno), notice };
  }
  return {
    status: "migrated",
    from: plan.from,
    to: plan.to,
    changed: plan.changed,
    added: plan.added,
    removed: plan.removed,
  };
}
