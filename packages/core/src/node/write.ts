import { stat } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import type { Plan, Skipped } from "../changes/plan.js";
import {
  currentLayout,
  currentSpec,
  type FileKind,
  type FormatRegistry,
  kindOfPath,
} from "../format.js";
import { isUnderFolder } from "../library-index/targets.js";
import { differsBesidesUpdatedAt, stampFile } from "../model/timestamps.js";
import { type CrossFile, crossFileIssues, type LinkEvent } from "../validation/cross.js";
import { checkLibraryFile, type FileCheck } from "../validation/file.js";
import { type Issue, makeIssue } from "../validation/issue.js";
import type { Snapshot } from "../validation/library.js";
import { sortIssues } from "../validation/report.js";
import { type Migrated, type PendingCleanup, resumeCleanup, runMigration } from "./migrate.js";
import { BACKUP, backupPresent, TOOL_FOLDER } from "./migration-backup.js";
import type { OpenFailure, SnapshotResult } from "./open.js";
import type { Written } from "./refresh.js";
import {
  checkFile,
  type Expected,
  type FileSystem,
  type IoFailure,
  realFileSystem,
  removeFile,
  replaceFile,
  type WriteOptions,
  type WriteOutcome,
} from "./replace-file.js";

/**
 * The write pipeline (docs/design.md section 4, "Writing library files" and "Write gate";
 * format-spec §5, §14, §16). Every write goes through here: it is gated, validated, canonicalized,
 * stamped and serialized before anything touches the disk, and a refusal leaves every file as it
 * was. A plan of several files is checked against the disk as a whole before the first rename,
 * then written in plan order, the primary change first; a stop after that reports the files
 * written and not written.
 */

/**
 * Something that happened beyond the plan: `migrated` when the gate migrated the library on disk
 * and reached the manifest marked `done` (docs/design.md section 3, "A write result").
 */
export type Notice = { code: "migrated"; from: number; to: number };

/** A failure that is not a validation issue (docs/design.md section 3). */
export type WriteFailure = IoFailure | Pick<OpenFailure, "code" | "message">;

interface Common {
  skipped: Skipped[];
  notices: Notice[];
}

export type WriteResult =
  | ({ status: "written"; written: string[] } & Common)
  | ({ status: "unchanged" } & Common)
  | ({ status: "refused"; issues: Issue[]; written: string[]; notWritten: string[] } & Common)
  | ({
      status: "failed";
      failure: WriteFailure;
      written: string[];
      notWritten: string[];
    } & Common);

/**
 * The options of `library.write` and `library.migrate`: those of the replace primitive, without
 * what the pipeline sets for each file; `fs` also serves the gate's look for the migration backup
 * (its `lstat`) and the migration runner. Besides the replace primitive's own points, `at` is
 * called by the migration runner when the gate migrates (its points are documented with
 * `RunnerOptions` in `migrate.ts`), then by the pipeline with `checked` once every target is
 * checked and before the first rename, then with `wrote:<path>` or `deleted:<path>` after each file
 * that was written or deleted.
 */
export interface LibraryWriteOptions
  extends Omit<WriteOptions, "expected" | "root" | "file" | "conflictCheck"> {
  /**
   * The time of the write, and of the claim when the gate migrates; tests fix time and skew.
   * Default: the system clock.
   */
  clock?: () => Date;
}

export type Build = (snapshot: Snapshot) => Plan | Promise<Plan>;

/** What the pipeline needs from the library handle. */
export interface WriteContext {
  root: string;
  registry: FormatRegistry;
  sha256: (bytes: Uint8Array) => string;
  /** A fresh snapshot: every call refreshes first (docs/design.md section 4, "Index"). */
  snapshot: () => Promise<SnapshotResult>;
  /**
   * Layer 9: told after each file that reached the disk, with the bytes written and their check
   * (`null` for a deletion), so the next refresh reads it back once and compares the bytes.
   */
  wrote?: (path: string, written: Written) => void;
  /** The host name a migration writes to `owner.json`. Default: `os.hostname()`. */
  hostName?: string;
  /** The process id a migration writes to `owner.json`. Default: `process.pid`. */
  pid?: number;
  /**
   * The handle's memory of a migration of its own whose cleanup failed too (docs/design.md section
   * 4, "Migration runner failures"): the gate resumes it before the next write. Without it, a
   * failed cleanup is not resumed.
   */
  cleanup?: { pending: PendingCleanup | null };
}

/**
 * What `library.migrate` gives (docs/design.md section 4, "`tastelib migrate`"): the gate ran with
 * no plan, and the library was `current` (nothing written) or `migrated`, or the gate stopped it
 * (`refused` or `failed`). `notices` holds `migrated` exactly as a write result does.
 */
export type MigrateResult =
  | { status: "current"; notices: Notice[] }
  | ({ notices: Notice[] } & Migrated)
  | { status: "refused"; issues: Issue[]; notices: Notice[] }
  | { status: "failed"; failure: WriteFailure; notices: Notice[] };

function errnoOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && !code.startsWith("ERR_") ? code : undefined;
}

/** What a write that ends with a refusal or a failure reports about the disk and the plan. */
interface Stopped {
  written: string[];
  notWritten: string[];
  skipped: Skipped[];
}

const nothing: Stopped = { written: [], notWritten: [], skipped: [] };

/**
 * A refusal, with its issues sorted as in format-spec §16.3. `written` and `notWritten` are empty
 * when the write was refused before it reached the disk.
 */
function refused(issues: Issue[], stopped: Stopped = nothing): WriteResult {
  return { status: "refused", issues: sortIssues(issues), ...stopped, notices: [] };
}

function failed(failure: WriteFailure, stopped: Stopped = nothing): WriteResult {
  return { status: "failed", failure, ...stopped, notices: [] };
}

const isError = (issue: Issue): boolean => issue.severity === "error";

/** What the gate gives: a result that ends the write, or the snapshot to plan on and its notices. */
type Gated =
  | { stop: WriteResult }
  | { snapshot: Snapshot; notices: Notice[]; migration: Migrated | null };

const withNotices = (result: WriteResult, notices: Notice[]): WriteResult => ({
  ...result,
  notices,
});

/**
 * The gate (docs/design.md section 4, "Write gate"), after the refresh: the migration backup,
 * `library.json`, newer files, and an older or mixed library, which it migrates on disk.
 */
async function gate(
  context: WriteContext,
  refreshed: Snapshot,
  options: LibraryWriteOptions,
): Promise<Gated> {
  const fs: FileSystem = options.fs ?? realFileSystem;
  let snapshot = refreshed;
  // 2. `.tastelib` must be a real folder: a link or junction there, wherever it leads, refuses
  //    every write before anything is looked for or written in it.
  try {
    if ((await fs.lstat(join(context.root, TOOL_FOLDER))).isSymbolicLink()) {
      return {
        stop: refused([
          makeIssue(
            "unreadable-file",
            TOOL_FOLDER,
            null,
            "The .tastelib folder is a symbolic link or junction; it must be a real folder. Remove the link.",
          ),
        ]),
      };
    }
  } catch (error) {
    const errno = errnoOf(error);
    if (errno === undefined) throw error;
    if (errno !== "ENOENT" && errno !== "ENOTDIR") {
      return {
        stop: failed({
          code: "io-error",
          operation: "lstat",
          file: TOOL_FOLDER,
          errno,
          message: `The .tastelib folder cannot be looked at (${errno}).`,
        }),
      };
    }
  }
  //    The migration backup. First, a cleanup of this handle's own migration that failed is
  //    finished, as the owner, if `owner.json` still holds its bytes; it changes library files, so
  //    the snapshot is refreshed again.
  const memory = context.cleanup;
  if (memory?.pending != null) {
    const resumed = await resumeCleanup(context, memory.pending, options);
    if (resumed.status === "refused") return { stop: refused(resumed.issues) };
    if (resumed.status === "failed") return { stop: failed(resumed.failure) };
    memory.pending = null;
    if (resumed.status === "done") {
      const fresh = await context.snapshot();
      if (!fresh.ok) return { stop: failed({ code: fresh.code, message: fresh.message }) };
      snapshot = fresh.snapshot;
    }
  }
  //    Then the backup itself. Until recovery is built (#39), every write gets `write-conflict`.
  try {
    if (await backupPresent(context.root, fs.lstat)) {
      return {
        stop: refused([
          makeIssue(
            "write-conflict",
            BACKUP,
            null,
            "A migration backup exists, so a migration is running or was interrupted; nothing was written. Try again later, or see `tastelib doctor`.",
          ),
        ]),
      };
    }
  } catch (error) {
    const errno = errnoOf(error);
    if (errno === undefined) throw error;
    return {
      stop: failed({
        code: "io-error",
        operation: "lstat",
        file: BACKUP,
        errno,
        message: `The migration backup folder cannot be looked for (${errno}).`,
      }),
    };
  }
  // 3. `library.json` that cannot be read leaves the library's version unknown.
  const library = snapshot.files.get("library.json");
  if (library !== undefined && (library.status === "invalid" || library.status === "unreadable")) {
    return { stop: refused([...library.issues]) };
  }
  // 4. and 5. answered by the version summary of the index, without another read.
  const versions = snapshot.index.versions;
  // 4. A file of a newer format anywhere: one issue per file.
  if (versions.newer.length > 0) {
    return {
      stop: refused(
        versions.newer.flatMap((path) => [...(snapshot.files.get(path)?.issues ?? [])]),
      ),
    };
  }
  // 5. An older or mixed library is migrated on disk first, then the snapshot is refreshed.
  if (!versions.needsMigration && versions.mixedFiles.length === 0) {
    return { snapshot, notices: [], migration: null };
  }
  const run = await runMigration(
    {
      root: context.root,
      registry: context.registry,
      sha256: context.sha256,
      hostName: context.hostName ?? hostname(),
      pid: context.pid ?? process.pid,
      wrote: context.wrote,
    },
    snapshot,
    options,
  );
  switch (run.status) {
    case "current":
      return { snapshot, notices: [], migration: null };
    case "blocked":
      return { stop: refused([...run.issues]) };
    case "refused":
      if (run.pending !== null && memory !== undefined) memory.pending = run.pending;
      return { stop: withNotices(refused(run.issues), run.notice === null ? [] : [run.notice]) };
    case "failed": {
      if (run.pending !== null && memory !== undefined) memory.pending = run.pending;
      const notices = run.notice === null ? [] : [run.notice];
      if (run.notice === null && run.failure.errno === "ENOENT") {
        // The library folder or its `library.json` went away (docs/design.md section 4, "Durability").
        const gone = await vanished(context.root);
        if (gone !== null) return { stop: failed(gone) };
      }
      return { stop: withNotices(failed(run.failure), notices) };
    }
    case "migrated": {
      const notices: Notice[] = [{ code: "migrated", from: run.from, to: run.to }];
      const fresh = await context.snapshot();
      if (!fresh.ok) {
        return { stop: withNotices(failed({ code: fresh.code, message: fresh.message }), notices) };
      }
      return { snapshot: fresh.snapshot, notices, migration: run };
    }
  }
}

/** The files of a snapshot as the cross-file checks take them. */
function crossFiles(snapshot: Snapshot): Map<string, CrossFile> {
  const files = new Map<string, CrossFile>();
  for (const [path, file] of snapshot.files) {
    files.set(path, {
      kind: file.kind,
      status: file.status,
      formatVersion: file.formatVersion,
      value: file.value,
    });
  }
  return files;
}

/** Every link held by the files in `paths`. */
function linksOf(
  files: Map<string, CrossFile>,
  context: WriteContext,
  unlistedFolders: readonly string[],
  paths: ReadonlySet<string>,
): LinkEvent[] {
  const links: LinkEvent[] = [];
  crossFileIssues(files, {
    current: context.registry.current,
    sha256: context.sha256,
    unlistedFolders,
    onLink: (link) => {
      if (paths.has(link.file)) links.push(link);
    },
  });
  return links;
}

/** A change after validation: the canonical new value, or `null` for a deletion. */
interface Prepared {
  path: string;
  kind: FileKind;
  value: unknown;
  /** The bytes the snapshot read, or `"absent"` for a new file. */
  expected: Expected;
  /** The canonical old value, `null` for a new file. */
  previous: unknown;
}

/**
 * The links that the plan adds and that do not resolve (docs/design.md section 4, "Validation"),
 * judged on one view of the library with the whole plan applied, deletions included. A link is new
 * unless the same holder of the same file already linked to the same target; one that was already
 * dangling is kept. A link into a file that exists but is not `valid` cannot be checked and is
 * refused too. Links that a deletion leaves dangling in files the plan does not change are not
 * new, so they never refuse it.
 */
function newBrokenLinks(context: WriteContext, snapshot: Snapshot, changes: Prepared[]): Issue[] {
  const paths = new Set(changes.filter((c) => c.value !== null).map((c) => c.path));
  if (paths.size === 0) return [];
  const before = crossFiles(snapshot);
  const after = new Map(before);
  for (const change of changes) {
    if (change.value === null) after.delete(change.path);
    else {
      after.set(change.path, {
        kind: change.kind,
        status: "valid",
        formatVersion: context.registry.current,
        value: change.value,
      });
    }
  }
  const key = (link: LinkEvent) => `${link.file}\u0000${link.holder}\u0000${link.target}`;
  const known = new Set(linksOf(before, context, snapshot.unlistedFolders, paths).map(key));
  const issues: Issue[] = [];
  for (const link of linksOf(after, context, snapshot.unlistedFolders, paths)) {
    if (link.state === "resolved" || known.has(key(link))) continue;
    issues.push(
      makeIssue(
        "dangling-link",
        link.file,
        link.pointer,
        link.state === "dangling"
          ? `${link.target} does not exist, so the link cannot be added.`
          : `${link.target} cannot be checked because ${link.targetFile} has errors; fix that file first.`,
      ),
    );
  }
  return issues;
}

/** The open failure when the library folder or its `library.json` no longer exists, else `null`. */
async function vanished(root: string): Promise<Pick<OpenFailure, "code" | "message"> | null> {
  for (const [path, failure] of [
    [root, { code: "unreadable-folder", message: "The library folder cannot be read (ENOENT)." }],
    [
      join(root, "library.json"),
      { code: "not-a-library", message: "The folder has no library.json, so it is not a library." },
    ],
  ] as const) {
    try {
      await stat(path);
    } catch (error) {
      if (errnoOf(error) === "ENOENT") return failure;
    }
  }
  return null;
}

/** The folder that could not be listed and holds `path`, or `undefined`. */
function unlistedFolderOf(snapshot: Snapshot, path: string): string | undefined {
  return snapshot.unlistedFolders.find((folder) => isUnderFolder(folder, path));
}

/**
 * Layer 2 of the pipeline: a plan may not replace or delete a file that is not `valid`, and is
 * refused with the issues of each such file, and of each file it is blocked by that is not
 * `valid`. A file it is blocked by that lies in a folder that could not be listed is unresolved
 * (docs/design.md section 4, "Links to files with errors"), so it blocks with the folder's issue.
 * A plan that breaks its own shape is a bug and throws.
 */
function blockingIssues(registry: FormatRegistry, snapshot: Snapshot, plan: Plan): Issue[] {
  const layout = currentLayout(registry);
  const seen = new Set<string>();
  const issues: Issue[] = [];
  const seenFolders = new Set<string>();
  for (const change of plan.changes) {
    if (seen.has(change.path)) throw new Error(`The plan changes "${change.path}" twice.`);
    seen.add(change.path);
    const kind = kindOfPath(layout, change.path);
    if (kind === null) throw new Error(`"${change.path}" is not a file of the format.`);
    // A change under a folder that could not be listed (a link out of the library, for example)
    // is refused with that folder's issues: the folder's files are unknown.
    const folder = unlistedFolderOf(snapshot, change.path);
    if (folder !== undefined) {
      if (!seenFolders.has(folder)) {
        seenFolders.add(folder);
        issues.push(...snapshot.issues.filter((issue) => issue.file === folder));
      }
      continue;
    }
    const existing = snapshot.files.get(change.path);
    if (change.next === null) {
      if (kind === "library") throw new Error("A plan may not delete library.json.");
      if (existing === undefined) {
        throw new Error(`The plan deletes "${change.path}", which the snapshot does not hold.`);
      }
    }
    // A file with errors may hold the user's words in a form the tool cannot read: only the user repairs it.
    if (existing !== undefined && existing.status !== "valid") issues.push(...existing.issues);
  }
  for (const path of plan.blockedBy ?? []) {
    if (seen.has(path)) continue;
    seen.add(path);
    const file = snapshot.files.get(path);
    if (file !== undefined) {
      if (file.status !== "valid") issues.push(...file.issues);
      continue;
    }
    const folder = unlistedFolderOf(snapshot, path);
    if (folder === undefined) {
      throw new Error(`The plan is blocked by "${path}", which the snapshot does not hold.`);
    }
    if (seenFolders.has(folder)) continue;
    seenFolders.add(folder);
    issues.push(...snapshot.issues.filter((issue) => issue.file === folder));
  }
  return issues;
}

const encoder = new TextEncoder();

/** One file ready for the disk: its final bytes and their check, or `null` for a deletion. */
interface Ready {
  path: string;
  kind: FileKind;
  bytes: Uint8Array | null;
  check: FileCheck | null;
  expected: Expected;
}

function conflictIssue(path: string, written: readonly string[]): Issue {
  return makeIssue(
    "write-conflict",
    path,
    null,
    written.length === 0
      ? "The file changed on disk after it was read, or a migration started; nothing was written. Read it again and retry."
      : "The file changed on disk after it was read, or a migration started; the files before it were written, and it and the files after it were not. Read it again and retry.",
  );
}

/**
 * Writes a plan of library files: validates every new value, refuses a new `dangling-link`,
 * canonicalizes, stamps the timestamps with one time, checks every target against the bytes that
 * were read, and only then replaces or deletes the files in plan order.
 */
export async function runWrite(
  context: WriteContext,
  build: Build,
  options: LibraryWriteOptions = {},
): Promise<WriteResult> {
  // 1. Refresh the snapshot, then the gate.
  const opened = await context.snapshot();
  if (!opened.ok) return failed({ code: opened.code, message: opened.message });
  const gated = await gate(context, opened.snapshot, options);
  if ("stop" in gated) return gated.stop;
  const result = await writePlan(context, gated.snapshot, build, options);
  // A notice of the gate stays in the result whatever happened to the plan (docs/design.md section 3).
  return gated.notices.length === 0 ? result : withNotices(result, gated.notices);
}

/**
 * `library.migrate` (docs/design.md section 4, "`tastelib migrate`"): the write gate with no plan.
 * It refreshes, checks the migration backup, `library.json` and newer files, and migrates an older
 * or mixed library on disk; a current library is left as it is, with nothing written.
 */
export async function runMigrate(
  context: WriteContext,
  options: LibraryWriteOptions = {},
): Promise<MigrateResult> {
  const opened = await context.snapshot();
  if (!opened.ok) {
    return {
      status: "failed",
      failure: { code: opened.code, message: opened.message },
      notices: [],
    };
  }
  const gated = await gate(context, opened.snapshot, options);
  if ("stop" in gated) {
    const stop = gated.stop;
    if (stop.status === "refused") {
      return { status: "refused", issues: stop.issues, notices: stop.notices };
    }
    if (stop.status === "failed") {
      return { status: "failed", failure: stop.failure, notices: stop.notices };
    }
    throw new Error(`The gate stopped with ${stop.status}.`);
  }
  if (gated.migration === null) return { status: "current", notices: gated.notices };
  return { ...gated.migration, notices: gated.notices };
}

/** Layers 2 to 9 of the pipeline, on the gated snapshot. */
async function writePlan(
  context: WriteContext,
  snapshot: Snapshot,
  build: Build,
  options: LibraryWriteOptions,
): Promise<WriteResult> {
  // 2. Plan, and the files it may not touch.
  const plan = await build(snapshot);
  const skipped = plan.skipped;
  const beforeDisk: Stopped = { ...nothing, skipped };
  const registry = context.registry;
  const blocking = blockingIssues(registry, snapshot, plan);
  if (blocking.length > 0) return refused(blocking, beforeDisk);

  // 4. Validate every new value: the schema and every rule within the file.
  const layout = currentLayout(registry);
  const spec = currentSpec(registry);
  const problems: Issue[] = [];
  const prepared: Prepared[] = [];
  for (const change of plan.changes) {
    const path = change.path;
    const kind = kindOfPath(layout, path) as FileKind;
    const existing = snapshot.files.get(path);
    const expected: Expected = existing?.bytes ?? "absent";
    const previous = existing === undefined ? null : spec.canonicalize(kind, existing.value);
    if (change.next === null) {
      prepared.push({ path, kind, value: null, expected, previous });
      continue;
    }
    const text = JSON.stringify(change.next);
    if (text === undefined) throw new Error("The new value cannot be written as JSON.");
    const checked = checkLibraryFile(registry, kind, path, encoder.encode(text));
    const errors = checked.issues.filter(isError);
    if (checked.formatVersion !== registry.current && errors.length === 0) {
      errors.push(
        makeIssue(
          "schema-violation",
          path,
          "/formatVersion",
          `formatVersion: must be ${registry.current}, the version this tool writes.`,
        ),
      );
    }
    problems.push(...errors);
    if (checked.status !== "valid" || errors.length > 0) continue;
    const value = spec.canonicalize(kind, checked.value);
    // A change that changes nothing is dropped, so a file that is merely not canonical is not rewritten.
    if (previous !== null && !differsBesidesUpdatedAt(previous, value)) continue;
    prepared.push({ path, kind, value, expected, previous });
  }
  if (problems.length > 0) return refused(problems, beforeDisk);
  if (prepared.length === 0) return { status: "unchanged", skipped, notices: [] };

  const links = newBrokenLinks(context, snapshot, prepared);
  if (links.length > 0) return refused(links, beforeDisk);

  // 6. and 7. Timestamps, with one time for every file, then the final value, validated again as
  //    an internal assertion.
  const now = (options.clock?.() ?? new Date()).toISOString();
  const ready: Ready[] = prepared.map(({ path, kind, value, expected, previous }) => {
    if (value === null) return { path, kind, bytes: null, check: null, expected };
    const bytes = encoder.encode(spec.serialize(kind, stampFile(kind, previous, value, now)));
    const final = checkLibraryFile(registry, kind, path, bytes);
    if (final.status !== "valid" || final.issues.length > 0) {
      throw new Error(
        `The write layer produced an invalid ${path}: ${JSON.stringify(final.issues)}`,
      );
    }
    return { path, kind, bytes, check: final, expected };
  });

  // 8. Replace. First every target is checked against the bytes that were read, so a change found
  //    before the first rename refuses the whole write (format-spec §5).
  const { clock: _clock, at, ...replaceOptions } = options;
  const paths = ready.map((file) => file.path);
  const optionsFor = (file: Ready): WriteOptions => ({
    ...replaceOptions,
    at,
    expected: file.expected,
    root: context.root,
    file: file.path,
    conflictCheck: () => backupPresent(context.root, (options.fs ?? realFileSystem).lstat),
  });
  const targetOf = (path: string) => join(context.root, ...path.split("/"));
  /** The result for a stop at `index`: the files before it were written, the rest were not. */
  const stopAt = async (
    index: number,
    outcome: Exclude<WriteOutcome, { status: "done" }>,
    applied = false,
  ): Promise<WriteResult> => {
    const cut = applied ? index + 1 : index;
    const lists: Stopped = { written: paths.slice(0, cut), notWritten: paths.slice(cut), skipped };
    if (!applied && (outcome.status === "write-conflict" || outcome.failure.errno === "ENOENT")) {
      // The library folder or its `library.json` went away since the snapshot was read (an
      // unmounted drive, a moved folder): the same failure `openLibrary` gives (docs/design.md
      // section 4, "Durability").
      const gone = await vanished(context.root);
      if (gone !== null) return failed(gone, lists);
    }
    if (outcome.status === "write-conflict") {
      return refused([conflictIssue(outcome.file, lists.written)], lists);
    }
    return failed(outcome.failure, lists);
  };

  for (const file of ready) {
    const check = await checkFile(targetOf(file.path), optionsFor(file));
    if (check.status === "write-conflict") return stopAt(0, check);
    if (check.status === "failed") {
      return stopAt(0, { ...check, applied: false, createdFolders: [] });
    }
  }
  await at?.("checked");

  for (const [index, file] of ready.entries()) {
    const target = targetOf(file.path);
    let outcome: WriteOutcome;
    if (file.bytes !== null) outcome = await replaceFile(target, file.bytes, optionsFor(file));
    else if (file.expected === "absent")
      throw new Error(`"${file.path}" to delete was never read.`);
    else outcome = await removeFile(target, { ...optionsFor(file), expected: file.expected });
    const applied = outcome.status === "done" || (outcome.status === "failed" && outcome.applied);
    // 9. The snapshot learns what reached the disk.
    if (applied) {
      context.wrote?.(
        file.path,
        file.bytes === null || file.check === null
          ? null
          : { kind: file.kind, bytes: file.bytes, check: file.check },
      );
    }
    if (outcome.status === "done") {
      await at?.(`${file.bytes === null ? "deleted" : "wrote"}:${file.path}`);
      continue;
    }
    return stopAt(index, outcome, applied);
  }
  return { status: "written", written: paths, skipped, notices: [] };
}
