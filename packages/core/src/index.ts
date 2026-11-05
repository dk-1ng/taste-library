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
export type { FileBytes } from "./node/read-file.js";
export { MAX_JSON_BYTES, readLibraryFileBytes } from "./node/read-file.js";
export type {
  Library as OpenLibrary,
  OpenFailure,
  OpenOptions,
  OpenResult,
  SnapshotResult,
} from "./node/open.js";
export { openLibrary } from "./node/open.js";
