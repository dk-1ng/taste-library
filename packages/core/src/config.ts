import { randomBytes } from "node:crypto";
import { lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, parse, win32 } from "node:path";
import { z } from "zod";

/** Per-machine configuration (docs/design.md section 4). Never part of a library. */

/**
 * Absolute on this operating system only (a Windows path on Linux would be relative to the current
 * folder), and free of `.` and `..` segments, which could hide the real location from the Git check.
 */
function isCleanAbsolutePath(value: string): boolean {
  const absolute =
    process.platform === "win32"
      ? /^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\/]+[\\/][^\\/]+/.test(value)
      : value.startsWith("/");
  if (!absolute) return false;
  return !value.split(/[\\/]/).some((segment) => segment === "." || segment === "..");
}

const absolutePath = z.string().min(1).refine(isCleanAbsolutePath, {
  message: 'must be an absolute path for this system, without "." or ".." segments',
});

export const configSchema = z.strictObject({
  version: z.literal(1),
  /** Folder of the library on this computer. */
  libraryPath: absolutePath.optional(),
  /** Media folder on this computer; must not sit inside a Git working tree. */
  mediaPath: absolutePath.optional(),
  /** Interface language (docs/design.md section 12). */
  language: z.enum(["en", "pt-BR"]).optional(),
  /** Where packs are exported (docs/design.md section 10). */
  packsExportPath: absolutePath.optional(),
});

export type Config = z.infer<typeof configSchema>;

export const DEFAULT_CONFIG: Config = { version: 1 };

/** Raised for every config problem. The message names the file and, when there is one, the field. */
export class ConfigError extends Error {
  readonly file: string;
  readonly field: string | undefined;

  constructor(file: string, message: string, field?: string) {
    super(field === undefined ? `${file}: ${message}` : `${file}: ${field}: ${message}`);
    this.name = "ConfigError";
    this.file = file;
    this.field = field;
  }
}

export interface ConfigEnvironment {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  home: string;
}

export function currentEnvironment(): ConfigEnvironment {
  return { platform: process.platform, env: process.env, home: homedir() };
}

/**
 * `%APPDATA%\tastelib\config.json` on Windows; `$XDG_CONFIG_HOME/tastelib/config.json` or
 * `~/.config/tastelib/config.json` on Linux and macOS.
 */
export function resolveConfigPath(environment: ConfigEnvironment = currentEnvironment()): string {
  const { platform, env, home } = environment;
  if (platform === "win32") {
    const appData = env["APPDATA"];
    if (appData === undefined || !win32.isAbsolute(appData)) {
      throw new ConfigError("config.json", "APPDATA is not set to an absolute path", "APPDATA");
    }
    return win32.join(appData, "tastelib", "config.json");
  }
  // The XDG spec says a relative XDG_CONFIG_HOME must be ignored.
  const xdg = env["XDG_CONFIG_HOME"];
  const base = xdg?.startsWith("/") ? xdg : join(home, ".config");
  return join(base, "tastelib", "config.json");
}

function fromZod(file: string, error: z.ZodError): ConfigError {
  const issue = error.issues[0];
  if (issue === undefined) return new ConfigError(file, "invalid configuration");
  // An unknown key has an empty path; its name is in `keys`.
  const keys = issue.code === "unrecognized_keys" ? issue.keys : [];
  const path = [...issue.path, ...keys].map(String).join(".");
  const message = issue.code === "unrecognized_keys" ? "unknown field" : issue.message;
  return new ConfigError(file, message, path === "" ? undefined : path);
}

/** Validates a value read from outside the process. */
export function parseConfig(value: unknown, file: string): Config {
  const result = configSchema.safeParse(value);
  if (!result.success) throw fromZod(file, result.error);
  return result.data;
}

const MAX_CONFIG_BYTES = 1024 * 1024;

/** Reads and validates the config. A missing file gives the defaults. */
export async function readConfig(file: string): Promise<Config> {
  let text: string;
  try {
    // One handle for the size check and the read, so a symbolic link or a change in between cannot bypass the limit.
    const handle = await open(file, "r");
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new ConfigError(file, "is not a regular file");
      if (info.size > MAX_CONFIG_BYTES) {
        throw new ConfigError(file, `is larger than ${MAX_CONFIG_BYTES} bytes`);
      }
      const buffer = Buffer.alloc(MAX_CONFIG_BYTES + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > MAX_CONFIG_BYTES) {
        throw new ConfigError(file, `is larger than ${MAX_CONFIG_BYTES} bytes`);
      }
      text = buffer.toString("utf8", 0, bytesRead);
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    if (isNodeError(error) && error.code === "ENOENT") return { ...DEFAULT_CONFIG };
    throw new ConfigError(file, `cannot be read (${errorCode(error)})`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    throw new ConfigError(file, "is not valid JSON");
  }
  return parseConfig(json, file);
}

/**
 * Refuses a media folder that sits inside a Git working tree (docs/design.md section 4):
 * walks up from the folder (or its nearest existing ancestor) looking for `.git`.
 */
export async function assertMediaOutsideGit(
  mediaPath: string,
  file = "config.json",
): Promise<void> {
  let current = mediaPath;
  // Resolve symbolic links on the nearest ancestor that exists.
  for (;;) {
    try {
      current = await realpath(current);
      break;
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") {
        throw new ConfigError(file, `cannot be checked (${errorCode(error)})`, "mediaPath");
      }
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  const root = parse(current).root;
  for (;;) {
    try {
      await lstat(join(current, ".git"));
      throw new ConfigError(
        file,
        `is inside a Git working tree (${join(current, ".git")}); media must live outside any repository`,
        "mediaPath",
      );
    } catch (error) {
      if (error instanceof ConfigError) throw error;
      if (!isNodeError(error) || error.code !== "ENOENT") {
        throw new ConfigError(file, `cannot be checked (${errorCode(error)})`, "mediaPath");
      }
    }
    if (current === root) return;
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

/** Validates, then replaces the file atomically (temporary file in the same folder, then rename). */
export async function writeConfig(file: string, config: Config): Promise<void> {
  const valid = parseConfig(config, file);
  if (valid.mediaPath !== undefined) await assertMediaOutsideGit(valid.mediaPath, file);
  const folder = dirname(file);
  const temporary = join(folder, `.config-${randomBytes(6).toString("hex")}.tmp`);
  try {
    await mkdir(folder, { recursive: true });
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(valid, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw new ConfigError(file, `cannot be written (${errorCode(error)})`);
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function errorCode(error: unknown): string {
  return isNodeError(error) && typeof error.code === "string" ? error.code : "unknown error";
}
