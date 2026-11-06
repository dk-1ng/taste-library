import {
  applySteps,
  currentSpec,
  type FileKind,
  type FormatLayout,
  type FormatRegistry,
  kindOfPath,
} from "../format.js";
import { versionSummary, type VersionSummary } from "../library-index/versions.js";
import { checkLibraryFile } from "../validation/file.js";
import { type Issue, makeIssue } from "../validation/issue.js";
import type { Snapshot, SnapshotFile } from "../validation/library.js";
import { sortIssues } from "../validation/report.js";
import { assembleView, crossFilesOf } from "../validation/view.js";

/**
 * The migration planner (format-spec §15.3 steps 1 to 3; docs/design.md section 3, "Core modules
 * and API", the migrated view): from the files of a library as read, the files a migration to the
 * current version would change, add and remove, their bytes, and the library as it would be
 * after it. Pure, and deterministic: the migration runner, `tastelib migrate --dry-run` and the
 * migrated view of the snapshot all plan here, so they never disagree. Nothing is written.
 */

/** What a migration would do, or why it cannot run. */
export type MigrationPlan =
  /** Every file is at the current version (or has no version to read): nothing to migrate. */
  | { status: "current" }
  /**
   * The migration cannot run. Step 1: a file has errors, cannot be read or is newer, or a folder
   * could not be listed; `issues` are those of the files and folders on disk. Step 3: errors remain
   * after the steps; `issues` are those errors, at the paths and pointers the files would have
   * after the migration, each message saying so.
   */
  | { status: "blocked"; step: 1 | 3; issues: readonly Issue[] }
  | {
      status: "ready";
      /**
       * The version migrated from, as the `migrated` notice gives it (docs/design.md section 4,
       * "Write gate"): `library.json`'s version when it is older, otherwise the lowest version
       * present.
       */
      from: number;
      /** The current version. */
      to: number;
      /** Files on disk whose value the migration changes, sorted by path. */
      changed: readonly string[];
      /** Files the migration adds, sorted by path. */
      added: readonly string[];
      /** Files on disk the migration removes, sorted by path. */
      removed: readonly string[];
      /** The bytes of every changed and added file, in the current version's canonical form, sorted by path. */
      bytes: ReadonlyMap<string, Uint8Array>;
      /**
       * The library as the migration would leave it: its files at their migrated paths, every
       * fingerprint `null`. A file the migration does not change keeps its entry, bytes included.
       */
      migrated: Snapshot;
    };

/** What the planner reads of a snapshot: its files, and the folders that could not be listed with their issues. */
export type MigrationInput = Pick<Snapshot, "files" | "unlistedFolders" | "issues">;

/**
 * Plans the migration of a library to the registry's current version. `sha256` is the one the
 * checks across files use (docs/design.md section 3).
 *
 * @throws when a step gives a path that is not a file of the current version, or that holds `.`,
 *   `..`, an empty name or a backslash: a step bug (paths come only from validated identifiers,
 *   docs/design.md section 14).
 */
export function planMigration(
  registry: FormatRegistry,
  snapshot: MigrationInput,
  sha256: (bytes: Uint8Array) => string,
): MigrationPlan {
  return migrationOf(registry, snapshot, sha256).plan;
}

/**
 * `planMigration`, with the issues of the checks across files of the migrated library, which the
 * snapshot's report holds (`validation/library.ts`). `versions` is the version summary of
 * `input.files`, when the caller already has it.
 */
export function migrationOf(
  registry: FormatRegistry,
  input: MigrationInput,
  sha256: (bytes: Uint8Array) => string,
  versions?: VersionSummary,
): { plan: MigrationPlan; cross: readonly Issue[] } {
  const current = registry.current;
  const summary = versions ?? versionSummary(crossFilesOf(input.files), current);
  const lowest = summary.present[0];
  if (lowest === undefined || lowest >= current) return { plan: { status: "current" }, cross: [] };

  // 1. Every file is read and valid at its own version, and every folder was listed.
  const blocking: Issue[] = [];
  for (const file of input.files.values()) {
    if (file.status !== "valid") blocking.push(...file.issues);
  }
  for (const issue of input.issues) {
    if (issue.file !== null && input.unlistedFolders.includes(issue.file)) blocking.push(issue);
  }
  if (blocking.length > 0 || input.unlistedFolders.length > 0) {
    return { plan: { status: "blocked", step: 1, issues: sortIssues(blocking) }, cross: [] };
  }

  // 2. The steps, in memory, from the lowest version present.
  const values = new Map<string, unknown>();
  for (const [path, file] of input.files) values.set(path, file.value);
  const out = applySteps(registry, values, lowest);

  // 3. Each file in the current version's canonical form, checked as the reader checks it, then
  //    the whole library with the checks across files.
  const spec = currentSpec(registry);
  const checked: SnapshotFile[] = [];
  const changed: string[] = [];
  const added: string[] = [];
  const bytes = new Map<string, Uint8Array>();
  for (const [path, value] of out) {
    const kind = migratedKind(spec.layout, path, current);
    const before = input.files.get(path);
    if (before !== undefined && sameJson(before.value, value)) {
      checked.push(before.fingerprint === null ? before : { ...before, fingerprint: null });
      continue;
    }
    const encoded = encoder.encode(textOf(registry, kind, value));
    const check = checkLibraryFile(registry, kind, path, encoded);
    checked.push({
      path,
      kind,
      bytes: encoded,
      fingerprint: null,
      formatVersion: check.formatVersion,
      status: check.status,
      value: check.value,
      issues: check.issues,
    });
    (before === undefined ? added : changed).push(path);
    bytes.set(path, encoded);
  }
  const removed = [...input.files.keys()].filter((path) => !out.has(path));

  const files = new Map(
    checked
      .map((file) => atCurrent(file, current))
      .sort((a, b) => compareText(a.path, b.path))
      .map((file) => [file.path, file]),
  );
  const view = assembleView(registry, files, [], sha256, []);
  const errors = view.snapshot.issues.filter((issue) => issue.severity === "error");
  if (errors.length > 0) {
    const issues = errors.map((issue) => afterMigration(issue, current));
    return { plan: { status: "blocked", step: 3, issues }, cross: [] };
  }
  const from = summary.library !== null && summary.library < current ? summary.library : lowest;
  return {
    plan: {
      status: "ready",
      from,
      to: current,
      changed: changed.sort(compareText),
      added: added.sort(compareText),
      removed: removed.sort(compareText),
      bytes: new Map([...bytes].sort(([a], [b]) => compareText(a, b))),
      migrated: view.snapshot,
    },
    cross: view.cross,
  };
}

/**
 * An issue found in the migrated library, as the report of the library on disk gives it: at its
 * migrated path and pointer, with a message that says it was found after the migration
 * (docs/design.md section 3, "The report").
 */
export function afterMigration(issue: Issue, version: number): Issue {
  const sentence = issue.message.endsWith(".") ? issue.message.slice(0, -1) : issue.message;
  return { ...issue, message: `${sentence} (found after migration to version ${version}).` };
}

const encoder = new TextEncoder();

/**
 * A migrated file as step 3 judges it: against the current version's schemas (format-spec §15.3),
 * so a file a step left at an older version, valid at its own, has an error at `/formatVersion`.
 */
function atCurrent(file: SnapshotFile, current: number): SnapshotFile {
  if (file.status !== "valid" || file.formatVersion === current) return file;
  const issue = makeIssue(
    "schema-violation",
    file.path,
    "/formatVersion",
    `formatVersion: is ${file.formatVersion}; must be ${current}, the version migrated to.`,
  );
  return { ...file, status: "invalid", value: null, issues: [...file.issues, issue] };
}

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The kind of a path a step gave, or a step bug. */
function migratedKind(layout: FormatLayout, path: string, version: number): FileKind {
  const unsafe = path
    .split("/")
    .some((name) => name === "" || name === "." || name === ".." || name.includes("\\"));
  const kind = unsafe ? null : kindOfPath(layout, path);
  if (kind === null) {
    throw new Error(
      `The migration to version ${version} gave the path ${JSON.stringify(path)}, which is not a file of that version.`,
    );
  }
  return kind;
}

/**
 * The text of a migrated value: its canonical form when it passes its schema, otherwise plain
 * two-space JSON, so that the check that follows reports what is wrong with it instead of the
 * serializer throwing.
 */
function textOf(registry: FormatRegistry, kind: FileKind, value: unknown): string {
  const spec = currentSpec(registry);
  const schema = Object.hasOwn(spec.schemas, kind) ? spec.schemas[kind] : undefined;
  if (schema?.safeParse(value).success) return spec.serialize(kind, value);
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** Whether two parsed JSON values are equal, in any key order. */
function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a)) {
    return Array.isArray(b) && a.length === b.length && a.every((item, i) => sameJson(item, b[i]));
  }
  if (typeof a !== "object" || a === null || typeof b !== "object" || b === null) return false;
  if (Array.isArray(b)) return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => Object.hasOwn(right, key) && sameJson(left[key], right[key]))
  );
}
