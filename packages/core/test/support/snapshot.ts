import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  FORMAT_REGISTRY,
  type FileKind,
  type FormatRegistry,
  layoutKindOf,
} from "../../src/format.js";
import { makeIssue } from "../../src/validation/issue.js";
import { buildSnapshot, type LibraryEntry, type Snapshot } from "../../src/validation/library.js";
import { GOLDEN_V1 } from "./golden.js";

/**
 * Snapshots of the golden v1 library built in memory, for tests of pure code that takes a
 * snapshot (the deletion planners, the migration planner). Test-only: it lives outside `src/`.
 */

export const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

/** Every file of the golden v1 library: relative path to parsed value. */
export function goldenFiles(): Map<string, unknown> {
  const files = new Map<string, unknown>();
  const walk = (relative: string): void => {
    for (const entry of readdirSync(join(GOLDEN_V1, ...relative.split("/").filter(Boolean)), {
      withFileTypes: true,
    })) {
      const path = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else files.set(path, JSON.parse(readFileSync(join(GOLDEN_V1, ...path.split("/")), "utf8")));
    }
  };
  walk("");
  return new Map([...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** The kind of `path` as the listing gives it: from the newest version whose layout has it. */
function listedKindOf(registry: FormatRegistry, path: string): FileKind | null {
  for (let version = registry.current; version >= 1; version -= 1) {
    const spec = registry.versions[version];
    const kind = spec === undefined ? null : layoutKindOf(spec.layout, path);
    if (kind !== null) return kind;
  }
  return null;
}

export interface GoldenSnapshotOptions {
  /** Folders to treat as existing but unreadable: their files are left out, as the listing does. */
  unlisted?: string[];
  /** Files to treat as listed but unreadable (`EACCES`). */
  unreadable?: string[];
  /** The format registry; the production one by default. */
  registry?: FormatRegistry;
}

/**
 * The golden v1 library as a snapshot. `edit` may change the parsed values in place, delete files,
 * or set a value to a string, which becomes the file's exact text (to make a file with errors).
 */
export function goldenSnapshot(
  edit?: (files: Map<string, unknown>) => void,
  options: GoldenSnapshotOptions = {},
): Snapshot {
  const files = goldenFiles();
  edit?.(files);
  return snapshotOf(files, options);
}

/**
 * A library built in memory from parsed values, as `goldenSnapshot` builds it: a string value is
 * the file's exact text, any other value is written as two-space JSON plus LF.
 */
export function snapshotOf(
  files: ReadonlyMap<string, unknown>,
  options: GoldenSnapshotOptions = {},
): Snapshot {
  const registry = options.registry ?? FORMAT_REGISTRY;
  const unlisted = options.unlisted ?? [];
  const unreadable = new Set(options.unreadable ?? []);
  const encoder = new TextEncoder();
  const entries: LibraryEntry[] = [];
  for (const [path, value] of files) {
    if (unlisted.some((folder) => path.startsWith(`${folder}/`))) continue;
    const kind = listedKindOf(registry, path);
    if (kind === null) throw new Error(`${path} is not a file of the format.`);
    if (unreadable.has(path)) {
      const issue = makeIssue("unreadable-file", path, null, "The file cannot be read (EACCES).");
      entries.push({ path, kind, read: { status: "failed", issue } });
      continue;
    }
    const text = typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`;
    entries.push({ path, kind, read: { status: "ok", bytes: encoder.encode(text) } });
  }
  const folderIssues = unlisted.map((folder) =>
    makeIssue("unreadable-file", folder, null, "The folder cannot be read (EACCES)."),
  );
  return buildSnapshot(registry, entries, folderIssues, sha256, unlisted);
}
