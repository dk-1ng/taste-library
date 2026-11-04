import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withTempDir } from "@tastelib/testkit";
import { describe, expect, it } from "vitest";
import {
  assertMediaOutsideGit,
  ConfigError,
  readConfig,
  resolveConfigPath,
  writeConfig,
} from "./config.js";

describe("resolveConfigPath", () => {
  it("uses ~/.config on Linux and macOS", () => {
    for (const platform of ["linux", "darwin"] as const) {
      expect(resolveConfigPath({ platform, env: {}, home: "/home/ana" })).toBe(
        join("/home/ana", ".config", "tastelib", "config.json"),
      );
    }
  });

  it("honors an absolute XDG_CONFIG_HOME and ignores a relative one", () => {
    const home = "/home/ana";
    expect(resolveConfigPath({ platform: "linux", env: { XDG_CONFIG_HOME: "/x/cfg" }, home })).toBe(
      join("/x/cfg", "tastelib", "config.json"),
    );
    expect(resolveConfigPath({ platform: "linux", env: { XDG_CONFIG_HOME: "rel" }, home })).toBe(
      join(home, ".config", "tastelib", "config.json"),
    );
  });

  it("uses %APPDATA% on Windows, with a non-ASCII user name", () => {
    const env = { APPDATA: "C:\\Users\\Usuário\\AppData\\Roaming" };
    expect(resolveConfigPath({ platform: "win32", env, home: "C:\\Users\\Usuário" })).toBe(
      "C:\\Users\\Usuário\\AppData\\Roaming\\tastelib\\config.json",
    );
  });

  it("fails on Windows when APPDATA is missing", () => {
    expect(() => resolveConfigPath({ platform: "win32", env: {}, home: "C:\\" })).toThrow(
      ConfigError,
    );
  });
});

describe("readConfig and writeConfig", () => {
  it("round-trips under a non-ASCII path", async () => {
    await withTempDir(async (dir) => {
      const file = join(dir, "cfg", "tastelib", "config.json");
      const config = {
        version: 1 as const,
        libraryPath: join(dir, "biblioteca"),
        mediaPath: join(dir, "mídia"),
        language: "pt-BR" as const,
        packsExportPath: join(dir, "packs"),
      };
      await writeConfig(file, config);
      expect(await readConfig(file)).toEqual(config);
      expect((await readFile(file, "utf8")).endsWith("\n")).toBe(true);
    });
  });

  it("returns the defaults when the file does not exist", async () => {
    await withTempDir(async (dir) => {
      expect(await readConfig(join(dir, "missing.json"))).toEqual({ version: 1 });
    });
  });

  it("leaves no temporary file behind", async () => {
    await withTempDir(async (dir) => {
      await writeConfig(join(dir, "config.json"), { version: 1 });
      await writeConfig(join(dir, "config.json"), { version: 1, language: "en" });
      expect(await readdir(dir)).toEqual(["config.json"]);
    });
  });

  it("names the file and the field of an invalid value", async () => {
    await withTempDir(async (dir) => {
      const file = join(dir, "config.json");
      await writeFile(file, JSON.stringify({ version: 1, language: "fr" }));
      const error = await readConfig(file).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).file).toBe(file);
      expect((error as ConfigError).field).toBe("language");
      expect((error as ConfigError).message).toContain(file);
      expect((error as ConfigError).message).toContain("language");
    });
  });

  it("rejects relative paths, unknown fields, bad JSON and a wrong version", async () => {
    await withTempDir(async (dir) => {
      const file = join(dir, "config.json");
      const cases: [string, string | undefined][] = [
        [JSON.stringify({ version: 1, mediaPath: "relative/dir" }), "mediaPath"],
        [JSON.stringify({ version: 1, extra: true }), "extra"],
        [JSON.stringify({ version: 2 }), "version"],
        [JSON.stringify([]), undefined],
        ["{ not json", undefined],
      ];
      for (const [text, field] of cases) {
        await writeFile(file, text);
        const error = await readConfig(file).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(ConfigError);
        expect((error as ConfigError).file).toBe(file);
        if (field !== undefined) expect((error as ConfigError).field).toBe(field);
      }
    });
  });

  it("refuses to write an invalid config and keeps the old file", async () => {
    await withTempDir(async (dir) => {
      const file = join(dir, "config.json");
      await writeConfig(file, { version: 1, language: "en" });
      await expect(writeConfig(file, { version: 1, mediaPath: "relative" })).rejects.toThrow(
        ConfigError,
      );
      expect(await readConfig(file)).toEqual({ version: 1, language: "en" });
    });
  });
});

describe("media folder outside Git", () => {
  it("refuses a media folder inside a Git working tree, existing or not", async () => {
    await withTempDir(async (dir) => {
      const repo = join(dir, "repositório");
      await mkdir(join(repo, ".git"), { recursive: true });
      await mkdir(join(repo, "media"));
      const file = join(dir, "config.json");
      for (const mediaPath of [join(repo, "media"), join(repo, "not", "yet"), repo]) {
        const error = await assertMediaOutsideGit(mediaPath, file).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(ConfigError);
        expect((error as ConfigError).field).toBe("mediaPath");
        await expect(writeConfig(file, { version: 1, mediaPath })).rejects.toThrow(
          /Git working tree/,
        );
      }
    });
  });

  it("treats a .git file (worktree or submodule) as a working tree", async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, ".git"), "gitdir: elsewhere\n");
      await expect(assertMediaOutsideGit(join(dir, "media"))).rejects.toThrow(/Git working tree/);
    });
  });

  it("accepts a media folder in a plain folder", async () => {
    await withTempDir(async (dir) => {
      const media = join(dir, "mídia");
      await mkdir(media);
      await assertMediaOutsideGit(media);
      await writeConfig(join(dir, "config.json"), { version: 1, mediaPath: media });
    });
  });
});
