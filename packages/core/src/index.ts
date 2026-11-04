// @tastelib/core: Data format: schemas, validated read/write, index, migrations.
export {
  assertMediaOutsideGit,
  type Config,
  ConfigError,
  type ConfigEnvironment,
  configSchema,
  DEFAULT_CONFIG,
  parseConfig,
  readConfig,
  resolveConfigPath,
  writeConfig,
} from "./config.js";
