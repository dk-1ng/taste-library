// @tastelib/core: Data format: schemas, validated read/write, index, migrations.

/**
 * The Node entry of `core`: everything, the pure modules of `./browser.ts` included. The
 * contract of the two entries and of pure code is in docs/design.md section 3, "Core modules and
 * API". The layout of `src/`, by what a module may touch:
 *
 * - `json/` (pure): the strict reader on bytes (`read.ts`) and the canonical form (`canonical.ts`).
 * - `schemas/v<N>/` (pure): the frozen zod schemas of format version N (format-spec §15.4):
 *   `shared.ts` for §4 of the spec, one module per file type, and `set.ts`, the schema set.
 * - `format.ts` (pure): `CURRENT_FORMAT_VERSION` and the format registry, with each version's
 *   schema set and folder layout (which relative paths are which file type).
 * - `validation/` (pure): the `Issue` type and the codes with their severities, the mapping
 *   from zod issues to issues with pointers and English messages, the checks within one file,
 *   the checks across files, the snapshot and the report of format-spec §16.3.
 * - `ids/` (pure): random identifiers, sequential numbers, slugs.
 * - `model/` (pure): derived values: the effective value, the derived state, region rounding
 *   and the timestamps a write sets.
 * - `library-index/` (pure): the index built from parsed files, the one rule that resolves
 *   links (`targets.ts`) and the version summary (`versions.ts`).
 * - `changes/` (pure): write plans, the deletion planners and link removal. Whether a plan adds a
 *   link that does not resolve is judged by the write pipeline in `node/write.ts`.
 * - `node/` (Node): everything that touches the operating system: listing and reading files,
 *   fingerprints, opening and refreshing a library, the atomic replace, the write pipeline and
 *   gate, media checks and the per-machine config.
 *
 * A folder is pure unless it is under `node/`; the lint rule in the root `biome.json` enforces it.
 */

export * from "./browser.js";
export {
  assertMediaOutsideGit,
  type Config,
  type ConfigEnvironment,
  ConfigError,
  configSchema,
  DEFAULT_CONFIG,
  parseConfig,
  readConfig,
  resolveConfigPath,
  writeConfig,
} from "./node/config.js";
export { findGitWorkTree, type GitWalk, isInside } from "./node/folders.js";
export { checkMedia, type MediaCheckOptions } from "./node/media.js";
export {
  type AttachLibrary,
  type AttachOptions,
  type AttachRefusalCode,
  type AttachResult,
  attachMediaFolder,
  guardMediaWrite,
  isIgnorableEntry,
  MARKER_FILE,
  type MediaGuardResult,
  readMarker,
} from "./node/media-folder.js";
export { mediaPathSegments, type ResolvedMedia, resolveMediaPath } from "./node/media-path.js";
export type {
  Library as OpenLibrary,
  OpenFailure,
  OpenOptions,
  OpenResult,
  SnapshotResult,
} from "./node/open.js";
export { openLibrary } from "./node/open.js";
export type { FileBytes } from "./node/read-file.js";
export { MAX_JSON_BYTES, readLibraryFileBytes } from "./node/read-file.js";
export type { StatFn } from "./node/refresh.js";
export {
  type CheckOutcome,
  checkFile,
  type Expected,
  type FileSystem,
  type IoFailure,
  removeFile,
  replaceFile,
  type WriteOptions,
  type WriteOutcome,
} from "./node/replace-file.js";
export {
  type Build,
  kindOfPath,
  type LibraryWriteOptions,
  type Notice,
  type WriteFailure,
  type WriteResult,
} from "./node/write.js";
