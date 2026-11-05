import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withTempDir } from "@tastelib/testkit";
import { describe, expect, it } from "vitest";
import { MAX_JSON_BYTES, readLibraryFileBytes } from "./read-file.js";

function fileOfSize(size: number): Buffer {
  // Valid JSON is not needed: this layer only reads bytes.
  return Buffer.alloc(size, 0x20);
}

describe("readLibraryFileBytes", () => {
  it("returns the exact bytes", async () => {
    await withTempDir(async (dir) => {
      const bytes = Buffer.from("﻿{\r\n}\r\n", "utf8");
      await writeFile(join(dir, "a.json"), bytes);
      const result = await readLibraryFileBytes(join(dir, "a.json"), "a.json");
      expect(result.status === "ok" && Buffer.from(result.bytes).equals(bytes)).toBe(true);
    });
  });

  it("returns the stat of the handle it read, with bigint times", async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, "a.json"), "{}\n");
      const result = await readLibraryFileBytes(join(dir, "a.json"), "a.json");
      if (result.status !== "ok") throw new Error(result.status);
      expect(result.stats.size).toBe(3n);
      expect(typeof result.stats.mtimeNs).toBe("bigint");
      expect(typeof result.stats.ino).toBe("bigint");
    });
  });

  it("reads a file of exactly 8 MiB", async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, "a.json"), fileOfSize(MAX_JSON_BYTES));
      const result = await readLibraryFileBytes(join(dir, "a.json"), "a.json");
      expect(result.status === "ok" && result.bytes.length).toBe(MAX_JSON_BYTES);
    });
  });

  it("gives file-too-large for one byte more", async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, "a.json"), fileOfSize(MAX_JSON_BYTES + 1));
      const result = await readLibraryFileBytes(join(dir, "a.json"), "a.json");
      expect(result).toMatchObject({
        status: "failed",
        issue: { code: "file-too-large", severity: "error", file: "a.json", pointer: null },
      });
      expect(result.status === "failed" && result.stats?.size).toBe(BigInt(MAX_JSON_BYTES + 1));
    });
  });

  it("reports a missing file as missing, not as an issue", async () => {
    await withTempDir(async (dir) => {
      expect(await readLibraryFileBytes(join(dir, "none.json"), "none.json")).toEqual({
        status: "missing",
      });
    });
  });

  it("gives unreadable-file for a folder, without the absolute path", async () => {
    await withTempDir(async (dir) => {
      await mkdir(join(dir, "folder.json"));
      const result = await readLibraryFileBytes(join(dir, "folder.json"), "folder.json");
      expect(result).toMatchObject({ status: "failed", issue: { code: "unreadable-file" } });
      expect(JSON.stringify(result)).not.toContain(dir);
    });
  });

  it("applies the limit to what a symbolic link points to", async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, "big.json"), fileOfSize(MAX_JSON_BYTES + 1));
      try {
        await symlink(join(dir, "big.json"), join(dir, "link.json"));
      } catch {
        return; // symbolic links need privileges on some Windows setups
      }
      const result = await readLibraryFileBytes(join(dir, "link.json"), "link.json");
      expect(result).toMatchObject({ status: "failed", issue: { code: "file-too-large" } });
    });
  });

  it("works in a folder with non-ASCII characters", async () => {
    await withTempDir(async (dir) => {
      const folder = join(dir, "Usuário");
      await mkdir(folder);
      await writeFile(join(folder, "a.json"), "{}");
      expect((await readLibraryFileBytes(join(folder, "a.json"), "a.json")).status).toBe("ok");
    });
  });
});
