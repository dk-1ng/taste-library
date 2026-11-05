import { execFileSync } from "node:child_process";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, sep } from "node:path";
import { withTempDir } from "@tastelib/testkit";
import { describe, expect, it } from "vitest";
import { type FileSystem, realFileSystem, removeFile, replaceFile } from "./replace-file.js";

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

class SimulatedCrash extends Error {}

/** Wraps the real file system; `fail` decides which calls throw an errno error. */
function faulty(
  fail: (operation: string, path: string, count: number) => string | undefined,
): FileSystem & { counts: Record<string, number> } {
  const counts: Record<string, number> = {};
  const guard =
    <A extends unknown[], R>(operation: string, call: (...args: A) => R) =>
    (...args: A): R => {
      counts[operation] = (counts[operation] ?? 0) + 1;
      const code = fail(operation, String(args[0]), counts[operation]);
      if (code !== undefined) {
        throw Object.assign(new Error(`${code}: injected`), { code });
      }
      return call(...args);
    };
  return {
    counts,
    open: guard("open", realFileSystem.open) as FileSystem["open"],
    rename: guard("rename", realFileSystem.rename),
    unlink: guard("unlink", realFileSystem.unlink),
    mkdir: guard("mkdir", realFileSystem.mkdir) as FileSystem["mkdir"],
    rmdir: realFileSystem.rmdir,
    stat: realFileSystem.stat as FileSystem["stat"],
  };
}

describe("replaceFile", () => {
  it("creates a file that did not exist", async () => {
    await withTempDir(async (dir) => {
      const target = join(dir, "a.json");
      const result = await replaceFile(target, bytes("new"), { expected: "absent" });
      expect(result).toEqual({ status: "done", createdFolders: [] });
      expect(await readFile(target, "utf8")).toBe("new");
      expect(await readdir(dir)).toEqual(["a.json"]);
    });
  });

  it("replaces a file whose bytes are those expected", async () => {
    await withTempDir(async (dir) => {
      const target = join(dir, "a.json");
      await writeFile(target, "old");
      const result = await replaceFile(target, bytes("new"), { expected: bytes("old") });
      expect(result.status).toBe("done");
      expect(await readFile(target, "utf8")).toBe("new");
      expect(await readdir(dir)).toEqual(["a.json"]);
    });
  });

  it("names the temporary file .<name>.tmp-<8 Crockford characters>", async () => {
    await withTempDir(async (dir) => {
      const target = join(dir, "a.json");
      const seen: string[] = [];
      await replaceFile(target, bytes("x"), {
        expected: "absent",
        at: async (point) => {
          if (point === "temp-written") seen.push(...(await readdir(dir)));
        },
      });
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatch(/^\.a\.json\.tmp-[0-9a-hjkmnp-tv-z]{8}$/);
    });
  });

  it("refuses with write-conflict when the file changed between read and rename", async () => {
    await withTempDir(async (dir) => {
      const target = join(dir, "a.json");
      await writeFile(target, "old");
      const result = await replaceFile(target, bytes("mine"), {
        expected: bytes("old"),
        at: async (point) => {
          if (point === "before-rename") await writeFile(target, "theirs");
        },
      });
      expect(result).toEqual({ status: "write-conflict", file: target });
      expect(await readFile(target, "utf8")).toBe("theirs");
      expect(await readdir(dir)).toEqual(["a.json"]);
    });
  });

  it("refuses when a file now exists where there was none", async () => {
    await withTempDir(async (dir) => {
      const target = join(dir, "a.json");
      const result = await replaceFile(target, bytes("mine"), {
        expected: "absent",
        at: async (point) => {
          if (point === "before-rename") await writeFile(target, "theirs");
        },
      });
      expect(result.status).toBe("write-conflict");
      expect(await readFile(target, "utf8")).toBe("theirs");
      expect(await readdir(dir)).toEqual(["a.json"]);
    });
  });

  it("refuses when the file was deleted meanwhile", async () => {
    await withTempDir(async (dir) => {
      const target = join(dir, "a.json");
      const result = await replaceFile(target, bytes("mine"), { expected: bytes("old") });
      expect(result.status).toBe("write-conflict");
      expect(await readdir(dir)).toEqual([]);
    });
  });

  it("creates missing folders, and removes them again after a refusal", async () => {
    await withTempDir(async (dir) => {
      const target = join(dir, "projects", "p", "a.json");
      const created = await replaceFile(target, bytes("x"), { expected: "absent" });
      expect(created).toEqual({
        status: "done",
        createdFolders: [join(dir, "projects"), join(dir, "projects", "p")],
      });

      const other = join(dir, "families", "f", "b.json");
      const refused = await replaceFile(other, bytes("x"), {
        expected: bytes("never there"),
      });
      expect(refused.status).toBe("write-conflict");
      expect(await readdir(dir)).toEqual(["projects"]);
    });
  });

  it("leaves the target byte for byte as it was after an I/O failure, with no temporary file", async () => {
    await withTempDir(async (dir) => {
      const target = join(dir, "a.json");
      await writeFile(target, "old");
      const result = await replaceFile(target, bytes("new"), {
        expected: bytes("old"),
        file: "a.json",
        fs: faulty((operation) => (operation === "rename" ? "EIO" : undefined)),
      });
      expect(result).toMatchObject({
        status: "failed",
        failure: { code: "io-error", operation: "rename", file: "a.json", errno: "EIO" },
      });
      expect(await readFile(target, "utf8")).toBe("old");
      expect(await readdir(dir)).toEqual(["a.json"]);
    });
  });

  it("reports a failure to create the temporary file", async () => {
    await withTempDir(async (dir) => {
      const result = await replaceFile(join(dir, "a.json"), bytes("x"), {
        expected: "absent",
        fs: faulty((operation) => (operation === "open" ? "ENOSPC" : undefined)),
      });
      expect(result).toMatchObject({
        status: "failed",
        failure: { operation: "write", errno: "ENOSPC" },
      });
      expect(await readdir(dir)).toEqual([]);
    });
  });

  it("cleans nothing on a crash, like a process that dies", async () => {
    await withTempDir(async (dir) => {
      const target = join(dir, "a.json");
      await writeFile(target, "old");
      await expect(
        replaceFile(target, bytes("new"), {
          expected: bytes("old"),
          at: (point) => {
            if (point === "before-rename") throw new SimulatedCrash("crash");
          },
        }),
      ).rejects.toBeInstanceOf(SimulatedCrash);
      expect(await readFile(target, "utf8")).toBe("old");
      expect((await readdir(dir)).filter((name) => name.includes(".tmp-"))).toHaveLength(1);
    });
  });

  it("works with non-ASCII paths", async () => {
    await withTempDir(async (dir) => {
      const folder = join(dir, "Usuário", "referências");
      await mkdir(folder, { recursive: true });
      const target = join(folder, "açaí.json");
      await writeFile(target, "velho");
      const result = await replaceFile(target, bytes("novo"), { expected: bytes("velho") });
      expect(result.status).toBe("done");
      expect(await readFile(target, "utf8")).toBe("novo");
      expect(await readdir(folder)).toEqual(["açaí.json"]);
    });
  });

  it("flushes the folder in durable mode on a real file system", async () => {
    await withTempDir(async (dir) => {
      const result = await replaceFile(join(dir, "a.json"), bytes("x"), {
        expected: "absent",
        durable: true,
      });
      expect(result.status).toBe("done");
    });
  });

  // A directory cannot be opened for reading on Windows, where the flush is skipped anyway.
  it.skipIf(process.platform === "win32")(
    "reports a failed folder flush as applied: the file is already written",
    async () => {
      await withTempDir(async (dir) => {
        const target = join(dir, "refs", "a.json");
        const result = await replaceFile(target, bytes("NEW"), {
          expected: "absent",
          durable: true,
          platform: "linux",
          fs: faulty((operation, path) =>
            operation === "open" && path === join(dir, "refs") ? "EIO" : undefined,
          ),
        });
        expect(result).toMatchObject({
          status: "failed",
          applied: true,
          createdFolders: [join(dir, "refs")],
          failure: { operation: "sync-folder", errno: "EIO" },
        });
        expect(await readFile(target, "utf8")).toBe("NEW");
      });
    },
  );

  // A directory cannot be opened for reading on Windows, where the flush is skipped anyway.
  it.skipIf(process.platform === "win32")(
    "flushes the parent of every folder it created, and skips flushing on Windows",
    async () => {
      await withTempDir(async (dir) => {
        const flushed: string[] = [];
        const watching = faulty((operation, path) => {
          if (operation === "open" && !path.includes(".tmp-") && !path.endsWith(".json")) {
            flushed.push(path);
          }
          return undefined;
        });
        await replaceFile(join(dir, "projects", "p", "a.json"), bytes("x"), {
          expected: "absent",
          durable: true,
          platform: "linux",
          fs: watching,
        });
        expect(flushed).toEqual([dir, join(dir, "projects"), join(dir, "projects", "p")]);

        flushed.length = 0;
        await replaceFile(join(dir, "b.json"), bytes("x"), {
          expected: "absent",
          durable: true,
          platform: "win32",
          fs: watching,
        });
        expect(flushed).toEqual([]);
      });
    },
  );

  it("never creates folders above the library root", async () => {
    await withTempDir(async (dir) => {
      const root = join(dir, "gone-lib");
      const result = await replaceFile(join(root, "references", "r.json"), bytes("x"), {
        expected: "absent",
        root,
      });
      expect(result).toMatchObject({
        status: "failed",
        applied: false,
        failure: { operation: "stat", errno: "ENOENT" },
      });
      expect(await readdir(dir)).toEqual([]);
    });
  });

  it("creates folders below an existing root", async () => {
    await withTempDir(async (dir) => {
      const result = await replaceFile(join(dir, "references", "r.json"), bytes("x"), {
        expected: "absent",
        root: dir,
      });
      expect(result).toEqual({ status: "done", createdFolders: [join(dir, "references")] });
    });
  });

  it("removes the folders already created when a deeper mkdir fails", async () => {
    await withTempDir(async (dir) => {
      const result = await replaceFile(join(dir, "projects", "p", "a.json"), bytes("x"), {
        expected: "absent",
        fs: faulty((operation, _path, count) =>
          operation === "mkdir" && count === 2 ? "EACCES" : undefined,
        ),
      });
      expect(result).toMatchObject({ status: "failed", failure: { operation: "mkdir" } });
      expect(await readdir(dir)).toEqual([]);
    });
  });

  it("refuses at once when the target changed size, without reading it", async () => {
    await withTempDir(async (dir) => {
      const target = join(dir, "a.json");
      await writeFile(target, "old");
      let reads = 0;
      const counting: FileSystem = {
        ...realFileSystem,
        open: (async (...args: Parameters<FileSystem["open"]>) => {
          const handle = await realFileSystem.open(...args);
          const read = handle.read.bind(handle) as (...a: unknown[]) => Promise<unknown>;
          (handle as { read: unknown }).read = (...a: unknown[]) => {
            reads += 1;
            return read(...a);
          };
          return handle;
        }) as FileSystem["open"],
      };
      const result = await replaceFile(target, bytes("mine"), {
        expected: bytes("old"),
        fs: counting,
        at: async (point) => {
          if (point === "before-rename") await writeFile(target, Buffer.alloc(1024, 0x20));
        },
      });
      expect(result.status).toBe("write-conflict");
      expect(reads).toBe(0);
      expect((await stat(target)).size).toBe(1024);
    });
  });

  it.skipIf(process.platform === "win32")(
    "does not hang on a FIFO at the target",
    async () => {
      await withTempDir(async (dir) => {
        const target = join(dir, "a.json");
        execFileSync("mkfifo", [target]);
        const result = await replaceFile(target, bytes("x"), { expected: "absent" });
        expect(result.status).toBe("write-conflict");
        expect(await readdir(dir)).toEqual(["a.json"]);
      });
    },
    10000,
  );

  it("returns an I/O error thrown by the caller's check, with nothing left behind", async () => {
    await withTempDir(async (dir) => {
      const result = await replaceFile(join(dir, "sub", "a.json"), bytes("x"), {
        expected: "absent",
        conflictCheck: async () => {
          throw Object.assign(new Error("EIO"), { code: "EIO" });
        },
      });
      expect(result).toMatchObject({
        status: "failed",
        failure: { operation: "conflict-check", errno: "EIO" },
      });
      expect(await readdir(dir)).toEqual([]);
    });
  });

  it("never recreates the root, even written with a trailing separator, when it vanishes during the walk", async () => {
    await withTempDir(async (dir) => {
      const root = join(dir, "lib");
      await mkdir(root);
      let statCalls = 0;
      const fs: FileSystem = {
        ...realFileSystem,
        stat: (async (...args: Parameters<FileSystem["stat"]>) => {
          statCalls += 1;
          if (statCalls === 2) await rm(root, { recursive: true });
          return realFileSystem.stat(...args);
        }) as FileSystem["stat"],
      };
      const result = await replaceFile(join(root, "references", "r.json"), bytes("x"), {
        expected: "absent",
        root: `${root}${sep}`,
        fs,
      });
      expect(result).toMatchObject({ status: "failed", failure: { errno: "ENOENT" } });
      expect(await readdir(dir)).toEqual([]);
    });
  });

  it("refuses a target outside the root", async () => {
    await withTempDir(async (dir) => {
      const root = join(dir, "lib");
      await mkdir(root);
      const result = await replaceFile(join(dir, "elsewhere", "a.json"), bytes("x"), {
        expected: "absent",
        root,
      });
      expect(result).toMatchObject({ status: "failed", failure: { errno: "EINVAL" } });
      expect(await readdir(dir)).toEqual(["lib"]);
    });
  });

  it("ends with write-conflict when the caller's check says a migration backup appeared", async () => {
    await withTempDir(async (dir) => {
      const target = join(dir, "a.json");
      await writeFile(target, "old");
      const result = await replaceFile(target, bytes("mine"), {
        expected: bytes("old"),
        conflictCheck: async () => true,
      });
      expect(result.status).toBe("write-conflict");
      expect(await readFile(target, "utf8")).toBe("old");
      expect(await readdir(dir)).toEqual(["a.json"]);
    });
  });

  it("lets an exception without an errno propagate from the cleanup", async () => {
    await withTempDir(async (dir) => {
      const target = join(dir, "a.json");
      await writeFile(target, "other");
      await expect(
        replaceFile(target, bytes("mine"), {
          expected: bytes("old"),
          fs: {
            ...realFileSystem,
            unlink: async () => {
              throw new SimulatedCrash("crash in cleanup");
            },
          },
        }),
      ).rejects.toBeInstanceOf(SimulatedCrash);
    });
  });
});

describe("Windows retries", () => {
  function clock() {
    let time = 0;
    const waits: number[] = [];
    return {
      waits,
      now: () => time,
      sleep: async (ms: number) => {
        waits.push(ms);
        time += ms;
      },
    };
  }

  it("retries EBUSY with doubling waits and succeeds", async () => {
    await withTempDir(async (dir) => {
      const target = join(dir, "a.json");
      await writeFile(target, "old");
      const time = clock();
      const fs = faulty((operation, _path, count) =>
        operation === "rename" && count <= 3 ? "EBUSY" : undefined,
      );
      const result = await replaceFile(target, bytes("new"), {
        expected: bytes("old"),
        platform: "win32",
        fs,
        ...time,
      });
      expect(result.status).toBe("done");
      expect(time.waits).toEqual([10, 20, 40]);
      expect(await readFile(target, "utf8")).toBe("new");
    });
  });

  it("caps the wait at 250 ms and gives io-error after 2 seconds, deleting the temporary file", async () => {
    await withTempDir(async (dir) => {
      const target = join(dir, "a.json");
      await writeFile(target, "old");
      const time = clock();
      const result = await replaceFile(target, bytes("new"), {
        expected: bytes("old"),
        platform: "win32",
        fs: faulty((operation) => (operation === "rename" ? "EPERM" : undefined)),
        ...time,
      });
      expect(result).toMatchObject({
        status: "failed",
        failure: { operation: "rename", errno: "EPERM" },
      });
      expect(time.waits.slice(0, 6)).toEqual([10, 20, 40, 80, 160, 250]);
      expect(Math.max(...time.waits)).toBe(250);
      expect(time.waits.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(2000);
      expect(await readFile(target, "utf8")).toBe("old");
      expect(await readdir(dir)).toEqual(["a.json"]);
    });
  });

  it("repeats the check before each retry: a changed target ends with write-conflict", async () => {
    await withTempDir(async (dir) => {
      const target = join(dir, "a.json");
      await writeFile(target, "old");
      const result = await replaceFile(target, bytes("mine"), {
        expected: bytes("old"),
        platform: "win32",
        fs: faulty((operation) => (operation === "rename" ? "EACCES" : undefined)),
        now: () => 0,
        sleep: async () => {
          await writeFile(target, "theirs");
        },
      });
      expect(result.status).toBe("write-conflict");
      expect(await readFile(target, "utf8")).toBe("theirs");
      expect(await readdir(dir)).toEqual(["a.json"]);
    });
  });

  it("calls the caller's check before each retry", async () => {
    await withTempDir(async (dir) => {
      const target = join(dir, "a.json");
      await writeFile(target, "old");
      let calls = 0;
      const result = await replaceFile(target, bytes("mine"), {
        expected: bytes("old"),
        platform: "win32",
        fs: faulty((operation) => (operation === "rename" ? "EBUSY" : undefined)),
        now: () => 0,
        sleep: async () => undefined,
        conflictCheck: async () => ++calls >= 3,
      });
      expect(result.status).toBe("write-conflict");
      expect(calls).toBe(3);
    });
  });

  it("never retries on Linux or macOS", async () => {
    await withTempDir(async (dir) => {
      const target = join(dir, "a.json");
      await writeFile(target, "old");
      const fs = faulty((operation) => (operation === "rename" ? "EPERM" : undefined));
      const result = await replaceFile(target, bytes("new"), {
        expected: bytes("old"),
        platform: "linux",
        fs,
      });
      expect(result.status).toBe("failed");
      expect(fs.counts["rename"]).toBe(1);
    });
  });

  it("retries a deletion the same way", async () => {
    await withTempDir(async (dir) => {
      const target = join(dir, "a.json");
      await writeFile(target, "old");
      const time = clock();
      const result = await removeFile(target, {
        expected: bytes("old"),
        platform: "win32",
        fs: faulty((operation, _p, count) =>
          operation === "unlink" && count === 1 ? "EBUSY" : undefined,
        ),
        ...time,
      });
      expect(result.status).toBe("done");
      expect(time.waits).toEqual([10]);
      expect(await readdir(dir)).toEqual([]);
    });
  });
});

describe("removeFile", () => {
  it("removes a file whose bytes are those expected", async () => {
    await withTempDir(async (dir) => {
      const target = join(dir, "a.json");
      await writeFile(target, "old");
      expect((await removeFile(target, { expected: bytes("old") })).status).toBe("done");
      expect(await readdir(dir)).toEqual([]);
    });
  });

  it("refuses with write-conflict when the file changed or is gone, and leaves it alone", async () => {
    await withTempDir(async (dir) => {
      const target = join(dir, "a.json");
      await writeFile(target, "theirs");
      const changed = await removeFile(target, { expected: bytes("old") });
      expect(changed.status).toBe("write-conflict");
      expect(await readFile(target, "utf8")).toBe("theirs");

      const gone = await removeFile(join(dir, "none.json"), { expected: bytes("old") });
      expect(gone.status).toBe("write-conflict");
    });
  });

  it("refuses when the file changes between the check and the removal hook", async () => {
    await withTempDir(async (dir) => {
      const target = join(dir, "a.json");
      await writeFile(target, "old");
      const result = await removeFile(target, {
        expected: bytes("old"),
        at: async () => {
          await writeFile(target, "theirs");
        },
      });
      expect(result.status).toBe("write-conflict");
      expect(await readFile(target, "utf8")).toBe("theirs");
    });
  });
});
