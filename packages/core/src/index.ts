// @tastelib/core: Data format: schemas, validated read/write, index, migrations.

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
export { checkMedia, type MediaCheckOptions } from "./node/media.js";
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
export type { StatFn } from "./node/refresh.js";
export { MAX_JSON_BYTES, readLibraryFileBytes } from "./node/read-file.js";
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
