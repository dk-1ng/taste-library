import { lstat } from "node:fs/promises";
import { join } from "node:path";
import {
  classifyEntry,
  currentLayout,
  type FormatLayout,
  type FormatRegistry,
  type LibraryFileKind,
} from "../format.js";
import { canonicalize, serialize } from "../json/canonical.js";
import { differsBesidesUpdatedAt, stampFile } from "../model/timestamps.js";
import { Slug } from "../schemas/v1/shared.js";
import { type CrossFile, crossFileIssues, type LinkEvent } from "../validation/cross.js";
import { checkLibraryFile } from "../validation/file.js";
import { type Issue, makeIssue } from "../validation/issue.js";
import type { Snapshot } from "../validation/library.js";
import type { OpenFailure, SnapshotResult } from "./open.js";
import { type IoFailure, replaceFile, type WriteOptions } from "./replace-file.js";

/**
 * The write pipeline for one library file (docs/design.md section 4, "Writing library files" and
 * "Write gate"; format-spec §5, §14, §16). Every write goes through here: it is gated, validated,
 * canonicalized, stamped and serialized before anything touches the disk, and a refusal leaves
 * every file as it was.
 */

/** A change to one library file: `path` relative to the library with `/`, and the new value. */
export interface FileChange {
  path: string;
  next: unknown;
}

export interface Skipped {
  path: string;
  reason: "invalid" | "unreadable" | "newer";
}

/** What an operation wants written; built from the gated snapshot. */
export interface Plan {
  changes: FileChange[];
  skipped: Skipped[];
}

/** Something that happened beyond the plan; the migration runner (#38) adds the `migrated` notice. */
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

export interface LibraryWriteOptions
  extends Omit<WriteOptions, "expected" | "root" | "file" | "conflictCheck"> {
  /** The time of the write; tests fix time and skew. Default: the system clock. */
  clock?: () => Date;
}

export type Build = (snapshot: Snapshot) => Plan | Promise<Plan>;

/** What the pipeline needs from the library handle. */
export interface WriteContext {
  root: string;
  registry: FormatRegistry;
  sha256: (bytes: Uint8Array) => string;
  /** A fresh snapshot (the first call after opening returns what was read while opening). */
  snapshot: () => Promise<SnapshotResult>;
}

const BACKUP = ".tastelib/migration-backup";

function errnoOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && !code.startsWith("ERR_") ? code : undefined;
}

/**
 * Whether `.tastelib/migration-backup/` exists, looked at now and never cached (format-spec
 * §15.3). An error with an errno other than "not there" is thrown as it is.
 */
async function backupPresent(root: string): Promise<boolean> {
  try {
    await lstat(join(root, ".tastelib", "migration-backup"));
    return true;
  } catch (error) {
    const errno = errnoOf(error);
    if (errno === "ENOENT" || errno === "ENOTDIR") return false;
    throw error;
  }
}

/** The type of the file at `path`, or `null` when the format has no such file. */
export function kindOfPath(layout: FormatLayout, path: string): LibraryFileKind | null {
  const segments = path.split("/");
  let parent = "";
  for (const [index, name] of segments.entries()) {
    const last = index === segments.length - 1;
    const entry = classifyEntry(layout, parent, name, !last);
    if (last) return entry.type === "file" ? entry.kind : null;
    if (entry.type !== "folder") return null;
    // A folder inside a thing folder is named for a thing (`projects/<slug>/`): never `..` or a path trick.
    if (index >= 1 && !Slug.safeParse(name).success) return null;
    parent = parent === "" ? name : `${parent}/${name}`;
  }
  return null;
}

const none: Common = { skipped: [], notices: [] };

function refused(issues: Issue[], skipped: Skipped[] = []): WriteResult {
  return { status: "refused", issues, written: [], notWritten: [], skipped, notices: [] };
}

function failed(failure: WriteFailure): WriteResult {
  return { status: "failed", failure, written: [], notWritten: [], ...none };
}

const isError = (issue: Issue): boolean => issue.severity === "error";

function ioFailure(operation: string, file: string, error: unknown, errno: string): WriteResult {
  const message = error instanceof Error ? error.message : String(error);
  return failed({ code: "io-error", operation, file, errno, message });
}

/** The gate (docs/design.md section 4, "Write gate"): a result that ends the write, or `null`. */
async function gate(context: WriteContext, snapshot: Snapshot): Promise<WriteResult | null> {
  // 2. The migration backup. Until recovery is built (#39), every write gets `write-conflict`.
  try {
    if (await backupPresent(context.root)) {
      return refused([
        makeIssue(
          "write-conflict",
          BACKUP,
          null,
          "A migration backup exists, so a migration is running or was interrupted; nothing was written. Try again later, or see `tastelib doctor`.",
        ),
      ]);
    }
  } catch (error) {
    const errno = errnoOf(error);
    if (errno === undefined) throw error;
    return ioFailure("lstat", BACKUP, error, errno);
  }
  // 3. `library.json` that cannot be read leaves the library's version unknown.
  const library = snapshot.files.get("library.json");
  if (library !== undefined && (library.status === "invalid" || library.status === "unreadable")) {
    return refused([...library.issues]);
  }
  // 4. A file of a newer format anywhere: one issue per file.
  const newer = [...snapshot.files.values()].filter((file) => file.status === "newer");
  if (newer.length > 0) return refused(newer.flatMap((file) => [...file.issues]));
  // 5. An older or mixed library is migrated first, which arrives with the migration runner
  //    (#38). Until then it is refused, so a write never mixes versions.
  const migration = snapshot.issues.filter(
    (issue) => issue.code === "needs-migration" || issue.code === "mixed-format-versions",
  );
  if (migration.length > 0) return refused(migration);
  return null;
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

function linksOf(
  files: Map<string, CrossFile>,
  context: WriteContext,
  unlistedFolders: readonly string[],
  path: string,
): LinkEvent[] {
  const links: LinkEvent[] = [];
  crossFileIssues(files, {
    current: context.registry.current,
    sha256: context.sha256,
    unlistedFolders,
    onLink: (link) => {
      if (link.file === path) links.push(link);
    },
  });
  return links;
}

/**
 * The links of `path` that the new value adds and that do not resolve (design layer 4). A link is
 * new unless the same holder already linked to the same target; one that was already dangling is
 * kept. A link into a file that exists but is not `valid` cannot be checked and is refused too.
 */
function newBrokenLinks(
  context: WriteContext,
  snapshot: Snapshot,
  path: string,
  kind: LibraryFileKind,
  next: unknown,
): Issue[] {
  const before = crossFiles(snapshot);
  const after = new Map(before);
  after.set(path, {
    kind,
    status: "valid",
    formatVersion: context.registry.current,
    value: next,
  });
  const known = new Set(
    linksOf(before, context, snapshot.unlistedFolders, path).map(
      (link) => `${link.holder}\u0000${link.target}`,
    ),
  );
  const issues: Issue[] = [];
  for (const link of linksOf(after, context, snapshot.unlistedFolders, path)) {
    if (link.state === "resolved" || known.has(`${link.holder}\u0000${link.target}`)) continue;
    issues.push(
      makeIssue(
        "dangling-link",
        path,
        link.pointer,
        link.state === "dangling"
          ? `${link.target} does not exist, so the link cannot be added.`
          : `${link.target} cannot be checked because ${link.targetFile} has errors; fix that file first.`,
      ),
    );
  }
  return issues;
}

const encoder = new TextEncoder();

/**
 * Writes one library file: validates the new value, refuses a new `dangling-link`, canonicalizes,
 * stamps the timestamps and replaces the file with the check against the bytes that were read.
 */
export async function runWrite(
  context: WriteContext,
  build: Build,
  options: LibraryWriteOptions = {},
): Promise<WriteResult> {
  // 1. Refresh the snapshot.
  const opened = await context.snapshot();
  if (!opened.ok) return failed({ code: opened.code, message: opened.message });
  const snapshot = opened.snapshot;

  const stopped = await gate(context, snapshot);
  if (stopped !== null) return stopped;

  // Plan.
  const plan = await build(snapshot);
  const common: Common = { skipped: plan.skipped, notices: [] };
  const [change, ...rest] = plan.changes;
  if (change === undefined) return { status: "unchanged", ...common };
  if (rest.length > 0) throw new Error("A write of more than one file is not supported yet.");

  const registry = context.registry;
  const kind = kindOfPath(currentLayout(registry), change.path);
  if (kind === null) throw new Error(`"${change.path}" is not a file of the format.`);
  const path = change.path;
  const existing = snapshot.files.get(path);
  // A file with errors may hold the user's words in a form the tool cannot read: only the user repairs it.
  if (existing !== undefined && existing.status !== "valid") {
    return refused([...existing.issues], plan.skipped);
  }

  // Validate: the schema and every rule within the file.
  const text = JSON.stringify(change.next);
  if (text === undefined) throw new Error("The new value cannot be written as JSON.");
  const checked = checkLibraryFile(registry, kind, path, encoder.encode(text));
  const problems = checked.issues.filter(isError);
  if (checked.formatVersion !== registry.current && problems.length === 0) {
    problems.push(
      makeIssue(
        "schema-violation",
        path,
        "/formatVersion",
        `formatVersion: must be ${registry.current}, the version this tool writes.`,
      ),
    );
  }
  if (checked.status !== "valid" || problems.length > 0) return refused(problems, plan.skipped);

  const canonical = canonicalize(kind, checked.value);
  const previous = existing === undefined ? null : canonicalize(kind, existing.value);
  if (previous !== null && !differsBesidesUpdatedAt(previous, canonical)) {
    return { status: "unchanged", ...common };
  }

  const links = newBrokenLinks(context, snapshot, path, kind, canonical);
  if (links.length > 0) return refused(links, plan.skipped);

  // Timestamps, then the final value, validated again as an internal assertion.
  const now = (options.clock?.() ?? new Date()).toISOString();
  const stamped = stampFile(kind, previous, canonical, now);
  const bytes = encoder.encode(serialize(kind, stamped));
  const final = checkLibraryFile(registry, kind, path, bytes);
  if (final.status !== "valid" || final.issues.length > 0) {
    throw new Error(`The write layer produced an invalid ${path}: ${JSON.stringify(final.issues)}`);
  }

  // Replace, with the check against the bytes that were read.
  const { clock: _clock, ...replaceOptions } = options;
  const outcome = await replaceFile(join(context.root, ...path.split("/")), bytes, {
    ...replaceOptions,
    expected: existing?.bytes ?? "absent",
    root: context.root,
    file: path,
    conflictCheck: () => backupPresent(context.root),
  });
  if (outcome.status === "done") return { status: "written", written: [path], ...common };
  if (outcome.status === "write-conflict") {
    return refused(
      [
        makeIssue(
          "write-conflict",
          path,
          null,
          "The file changed on disk after it was read, or a migration started; nothing was written. Read it again and retry.",
        ),
      ],
      plan.skipped,
    );
  }
  return {
    status: "failed",
    failure: outcome.failure,
    written: outcome.applied ? [path] : [],
    notWritten: outcome.applied ? [] : [path],
    ...common,
  };
}
