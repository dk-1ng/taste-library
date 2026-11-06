import type { z } from "zod";
import {
  canonicalIssue,
  canonicalize,
  type FileType,
  isFileType,
  serialize,
} from "./json/canonical.js";
import type { ReadOk } from "./json/read.js";
import { FORMAT_STEPS, type LibraryValues, type MigrationStep } from "./migrations/steps.js";
import { v1Schemas } from "./schemas/v1/set.js";
import type { Issue } from "./validation/issue.js";

/**
 * The format registry (docs/design.md section 3, "Core modules and API"; format-spec §15): for
 * each format version its file kinds (its schema set and folder layout: which relative paths are
 * which kind) and its canonical form, and the steps from one version to the next. Pure. At
 * version 1 there is no step; the reader and the writer take the registry as a parameter, so
 * tests pass one with a test-only version 2 (docs/design.md section 15, "Core test approach").
 */

/** The kinds of file of version 1 in the library folder (the media marker lives in the media folder). */
export type LibraryFileKind = Exclude<FileType, "marker">;

/**
 * The kind of a library file, as a version's layout names it. A later version may add kinds (a
 * test-only version 2 adds one), so code that works on every version takes any kind its registry
 * names, and code with the meaning of a kind (links, deletions) handles the kinds it knows and
 * passes over the others.
 */
export type FileKind = LibraryFileKind | (string & {});

/**
 * The schema of each kind of file of one version, keyed by kind, and the media marker's (which
 * has its own version, format-spec §15.1).
 */
export type SchemaSet = Readonly<Record<string, z.ZodType>> & { readonly marker: z.ZodType };

/** Where each kind of file sits (format-spec §5). */
export interface FormatLayout {
  /** Files at the top of the library, by name. */
  files: Readonly<Record<string, FileKind>>;
  /** Folders that hold one file per thing, as `<folder>/<name>.json`. */
  flatFolders: Readonly<Record<string, FileKind>>;
  /** Folders that hold one subfolder per thing, each with the named files. */
  nestedFolders: Readonly<Record<string, Readonly<Record<string, FileKind>>>>;
  /**
   * The name a file's path gives the thing it holds, and the field of the file that must say the
   * same (otherwise `name-mismatch`, format-spec §5); `null` for a file with no such field.
   */
  identityOf(path: string, kind: FileKind): { name: string; field: string } | null;
}

export interface FormatVersionSpec {
  schemas: SchemaSet;
  layout: FormatLayout;
  /**
   * The canonical value of a file of this version (format-spec §3.3): keys in the schema's order,
   * lists sorted, proportions rounded. The input is not changed.
   *
   * @throws when `value` does not pass the schema of `kind`, or `kind` is not a kind of this version.
   */
  canonicalize(kind: FileKind, value: unknown): unknown;
  /**
   * The canonical text of a file of this version, whose UTF-8 bytes are the file's canonical
   * bytes: two-space JSON plus one LF, no BOM (format-spec §3.1, §3.3).
   *
   * @throws as `canonicalize` does.
   */
  serialize(kind: FileKind, value: unknown): string;
  /**
   * The `not-canonical` warning of a file of this version, or `null` when the bytes are canonical.
   * `parsed` is the output of the file's schema for `read.value`.
   */
  canonical?: (kind: FileKind, file: string, read: ReadOk, parsed: unknown) => Issue | null;
}

export interface FormatRegistry {
  /** The highest version this tool supports; it reads 1 to `current` and writes only `current`. */
  current: number;
  versions: Readonly<Record<number, FormatVersionSpec>>;
  /**
   * `steps[n]` turns a whole library from version n to version n + 1 (format-spec §15.4): pure,
   * deterministic and synchronous. It touches only files at version n and passes the others
   * through unchanged.
   */
  steps: Readonly<Record<number, MigrationStep>>;
}

export const CURRENT_FORMAT_VERSION = 1;

const V1_LAYOUT: FormatLayout = {
  files: {
    "library.json": "library",
    "glossary.json": "glossary",
    "guardrails.json": "guardrails",
    "taste-profile.json": "taste-profile",
  },
  flatFolders: { references: "reference", families: "family" },
  nestedFolders: { projects: { "project.json": "project", "directions.json": "directions" } },
  identityOf(path, kind) {
    const segments = path.split("/");
    if (kind === "reference" || kind === "family") {
      const file = segments[segments.length - 1] ?? "";
      return {
        name: file.endsWith(".json") ? file.slice(0, -".json".length) : file,
        field: kind === "reference" ? "id" : "slug",
      };
    }
    if (kind === "project") return { name: segments[1] ?? "", field: "slug" };
    return null;
  },
};

/** A kind of version 1, or a bug in the caller: a kind no version 1 file has. */
function v1Kind(kind: FileKind): LibraryFileKind {
  if (!isFileType(kind) || kind === "marker") {
    throw new Error(`"${kind}" is not a kind of file of format version 1.`);
  }
  return kind;
}

/** The production registry: version 1 only, and no step (`migrations/steps.ts`). */
export const FORMAT_REGISTRY: FormatRegistry = {
  current: CURRENT_FORMAT_VERSION,
  versions: {
    1: {
      schemas: v1Schemas,
      layout: V1_LAYOUT,
      canonicalize: (kind, value) => canonicalize(v1Kind(kind), value),
      serialize: (kind, value) => serialize(v1Kind(kind), value),
      canonical: (kind, file, read, parsed) => canonicalIssue(v1Kind(kind), file, read, parsed),
    },
  },
  steps: FORMAT_STEPS,
};

/**
 * Applies the registry's steps from version `from` up to the current one, in order, in memory
 * (format-spec §15.3 step 2). Each step touches only the files at its own version, so a library
 * with mixed file versions starts at the lowest one. `library` must already pass, file by file,
 * the schemas of each file's own version; it is not changed.
 *
 * @throws when `from` is not a version of the registry, or a step is missing (a registry bug).
 */
export function applySteps(
  registry: FormatRegistry,
  library: LibraryValues,
  from: number,
): LibraryValues {
  if (!Number.isSafeInteger(from) || from < 1 || from > registry.current) {
    throw new Error(`${from} is not a format version from 1 to ${registry.current}.`);
  }
  let migrated = library;
  for (let version = from; version < registry.current; version += 1) {
    const step = registry.steps[version];
    if (step === undefined) throw new Error(`The registry has no step from version ${version}.`);
    migrated = step(migrated);
  }
  return migrated;
}

/** The version the tool writes: its schemas, layout and canonical form. */
export function currentSpec(registry: FormatRegistry): FormatVersionSpec {
  const spec = registry.versions[registry.current];
  if (spec === undefined) throw new Error(`The registry has no version ${registry.current}.`);
  return spec;
}

/** The layout of the version the tool writes, which is the one the folders are listed with. */
export function currentLayout(registry: FormatRegistry): FormatLayout {
  return currentSpec(registry).layout;
}

/** A leftover temporary file of an interrupted write: `.<name>.tmp-<8 random>` (format-spec §5). */
const TEMP_FILE = /^\..+\.tmp-[0-9a-hjkmnp-tv-z]{8}$/;

/** An own property of a record, never one inherited from `Object.prototype` (`constructor`). */
function own<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

export type EntryClass =
  | { type: "file"; kind: FileKind }
  | { type: "folder" }
  | { type: "leftover-temp-file" }
  | { type: "unexpected" }
  | { type: "ignore" };

/**
 * What a name found in a folder of the library is. `parent` is the folder's path relative to the
 * library (`""` for the library itself). Names are compared as given, so the caller normalizes
 * them first (docs/design.md section 13).
 */
export function classifyEntry(
  layout: FormatLayout,
  parent: string,
  name: string,
  isDirectory: boolean,
): EntryClass {
  if (parent === "") {
    const kind = own(layout.files, name);
    if (kind !== undefined) return { type: "file", kind };
    const known =
      Object.hasOwn(layout.flatFolders, name) || Object.hasOwn(layout.nestedFolders, name);
    return known && isDirectory ? { type: "folder" } : { type: "ignore" };
  }
  if (!isDirectory && TEMP_FILE.test(name)) return { type: "leftover-temp-file" };
  const flat = own(layout.flatFolders, parent);
  if (flat !== undefined) {
    return !isDirectory && name.endsWith(".json")
      ? { type: "file", kind: flat }
      : { type: "unexpected" };
  }
  if (Object.hasOwn(layout.nestedFolders, parent)) {
    return isDirectory ? { type: "folder" } : { type: "unexpected" };
  }
  const slash = parent.indexOf("/");
  const nested = slash === -1 ? undefined : own(layout.nestedFolders, parent.slice(0, slash));
  const kind = nested === undefined ? undefined : own(nested, name);
  return kind !== undefined && !isDirectory ? { type: "file", kind } : { type: "unexpected" };
}
