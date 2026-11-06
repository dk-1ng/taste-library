import type { z } from "zod";
import { canonicalIssue, type FileType } from "./json/canonical.js";
import type { ReadOk } from "./json/read.js";
import { v1Schemas } from "./schemas/v1/set.js";
import type { Issue } from "./validation/issue.js";

/**
 * The format registry (docs/design.md section 3, "Core modules and API"): for each format version
 * its schema set and its folder layout (which relative paths are which file type). Pure. The
 * steps from one version to the next arrive with the migration runner (#38); at version 1 there is
 * none, and the reader takes the registry as a parameter so tests can pass one with a version 2.
 */

/** The type of a file in the library folder (the media marker lives in the media folder). */
export type LibraryFileKind = Exclude<FileType, "marker">;

export type SchemaSet = Readonly<Record<FileType, z.ZodType>>;

/** Where each kind of file sits (format-spec §5). */
export interface FormatLayout {
  /** Files at the top of the library, by name. */
  files: Readonly<Record<string, LibraryFileKind>>;
  /** Folders that hold one file per thing, as `<folder>/<name>.json`. */
  flatFolders: Readonly<Record<string, LibraryFileKind>>;
  /** Folders that hold one subfolder per thing, each with the named files. */
  nestedFolders: Readonly<Record<string, Readonly<Record<string, LibraryFileKind>>>>;
  /**
   * The name a file's path gives the thing it holds, and the field of the file that must say the
   * same (otherwise `name-mismatch`, format-spec §5); `null` for a file with no such field.
   */
  identityOf(path: string, kind: LibraryFileKind): { name: string; field: string } | null;
}

export interface FormatVersionSpec {
  schemas: SchemaSet;
  layout: FormatLayout;
  /**
   * The `not-canonical` warning of a file of this version, or `null` when the bytes are canonical.
   * `parsed` is the output of the file's schema for `read.value`.
   */
  canonical?: (kind: LibraryFileKind, file: string, read: ReadOk, parsed: unknown) => Issue | null;
}

export interface FormatRegistry {
  /** The highest version this tool supports; it reads 1 to `current` and writes only `current`. */
  current: number;
  versions: Readonly<Record<number, FormatVersionSpec>>;
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

/** The production registry: version 1 only. */
export const FORMAT_REGISTRY: FormatRegistry = {
  current: CURRENT_FORMAT_VERSION,
  versions: {
    1: {
      schemas: v1Schemas,
      layout: V1_LAYOUT,
      canonical: (kind, file, read, parsed) => canonicalIssue(kind, file, read, parsed),
    },
  },
};

/** The layout of the version the tool writes, which is the one the folders are listed with. */
export function currentLayout(registry: FormatRegistry): FormatLayout {
  const spec = registry.versions[registry.current];
  if (spec === undefined) throw new Error(`The registry has no version ${registry.current}.`);
  return spec.layout;
}

/** A leftover temporary file of an interrupted write: `.<name>.tmp-<8 random>` (format-spec §5). */
const TEMP_FILE = /^\..+\.tmp-[0-9a-hjkmnp-tv-z]{8}$/;

/** An own property of a record, never one inherited from `Object.prototype` (`constructor`). */
function own<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

export type EntryClass =
  | { type: "file"; kind: LibraryFileKind }
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
