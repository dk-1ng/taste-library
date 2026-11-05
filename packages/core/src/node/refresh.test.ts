import { createHash } from "node:crypto";
import { existsSync, type BigIntStats } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { editJson, withGoldenCopy } from "../../test/support/golden.js";
import { type Json, open, tree } from "../../test/support/library.js";
import { expectMatchesRebuild } from "../../test/support/rebuild.js";
import { makeIssue } from "../validation/issue.js";
import type { Snapshot } from "../validation/library.js";
import type { Library, OpenOptions } from "./open.js";
import { readLibraryFileBytes } from "./read-file.js";
import type { StatFn } from "./refresh.js";

const A = "ref-20261101-a1b2c3";
const B = "ref-20261102-d4e5f6";
const D = "ref-20261104-m2n3p4";
const HOUR = 3_600_000;
/** A clock one hour ahead: every file on disk is settled. */
const settled = { statClock: () => Date.now() + HOUR };
const clock = () => new Date("2026-11-05T10:00:00.000Z");

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

async function snap(library: Library): Promise<Snapshot> {
  const result = await library.snapshot();
  if (!result.ok) throw new Error(result.message);
  return result.snapshot;
}

const pathOf = (dir: string, relative: string): string => join(dir, ...relative.split("/"));

/** The parsed value of a file of the snapshot; fails the test when the file is not there. */
function parsed(snapshot: Snapshot, path: string): Json {
  const file = snapshot.files.get(path);
  if (file === undefined) throw new Error(`no ${path}`);
  return file.value;
}

/** A proposal to review for `p0` of a reference whose note is `note`. */
const proposal = (note: string): Json => ({
  origin: "agent",
  proposedBy: "claude-code",
  proposedAt: "2026-11-05T09:00:00.000Z",
  inputSha256: sha256(note),
  proposal: {
    summary: "A calm page.",
    vocabulary: [],
    keywords: [],
    screenTypes: [],
    components: [],
    aspects: [],
  },
  status: "to-review",
  correction: null,
  reviewedAt: null,
});

/** A `readFile` hook that records the relative path of every file read. */
function countingReads(): { reads: string[]; readFile: OpenOptions["readFile"] } {
  const reads: string[] = [];
  return {
    reads,
    readFile: async (path, file) => {
      reads.push(file);
      return readLibraryFileBytes(path, file);
    },
  };
}

/** A `stat` hook that answers with frozen stats for the paths given, and counts every call. */
function frozenStats(): { frozen: Map<string, BigIntStats>; calls: string[]; stat: StatFn } {
  const frozen = new Map<string, BigIntStats>();
  const calls: string[] = [];
  return {
    frozen,
    calls,
    stat: async (path, options) => {
      calls.push(path);
      return frozen.get(path) ?? stat(path, options);
    },
  };
}

/** Rewrites a file with other bytes of the same length (a character of its text is swapped). */
async function rewriteSameSize(file: string, from: string, to: string): Promise<void> {
  const text = await readFile(file, "utf8");
  expect(from.length).toBe(to.length);
  expect(text).toContain(from);
  await writeFile(file, text.replace(from, to));
}

describe("a refresh sees changes made outside the handle", () => {
  it("a write through a second handle: the new value and the new derived state", async () => {
    await withGoldenCopy(async (dir) => {
      const first = await open(dir);
      expect((await snap(first)).index.references.get(B)?.state).toBe("inbox");
      const second = await open(dir);
      const result = await second.write(
        (snapshot) => {
          const value = structuredClone(snapshot.files.get(`references/${B}.json`)?.value) as Json;
          value.interpretations.p0 = proposal(value.note);
          return { changes: [{ path: `references/${B}.json`, next: value }], skipped: [] };
        },
        { clock },
      );
      expect(result.status).toBe("written");
      const after = await snap(first);
      expect(after.index.references.get(B)?.state).toBe("processed");
      expect(parsed(after, `references/${B}.json`).interpretations.p0).toEqual(proposal(""));
    });
  });

  it("a same-size rewrite whose mtime is put back, on a settled file (ctime and inode)", async () => {
    await withGoldenCopy(async (dir) => {
      const file = pathOf(dir, "glossary.json");
      const old = Math.floor(Date.now() / 1000) - 7200;
      await utimes(file, old, old);
      const library = await open(dir, undefined, settled);
      const before = await stat(file, { bigint: true });
      await rewriteSameSize(file, "little noise.", "little noize.");
      await utimes(file, old, old);
      const after = await stat(file, { bigint: true });
      expect([after.size, after.mtimeNs]).toEqual([before.size, before.mtimeNs]);
      const glossary = parsed(await snap(library), "glossary.json");
      expect(glossary.terms[0].entry.content.definition).toBe("Much information, little noize.");
    });
  });

  it("a new file, and a file that is deleted with its backlinks and family memberships", async () => {
    await withGoldenCopy(async (dir) => {
      const library = await open(dir, undefined, settled);
      const before = await snap(library);
      expect(before.index.familiesOf.get(`${A}#p0`)).toEqual([
        { slug: "quiet-editorial", tentative: false },
      ]);
      const copy = "ref-20261105-q1w2e3";
      await editJson(dir, `references/${B}.json`, () => undefined);
      const text = (await readFile(pathOf(dir, `references/${B}.json`), "utf8")).replaceAll(
        B,
        copy,
      );
      await writeFile(pathOf(dir, `references/${copy}.json`), text);
      await rm(pathOf(dir, "families/quiet-editorial.json"));
      const after = await snap(library);
      expect(after.index.references.get(copy)?.state).toBe("inbox");
      expect(after.index.families.has("quiet-editorial")).toBe(false);
      expect(after.index.familiesOf.get(`${A}#p0`)).toBeUndefined();
      expect(
        (after.index.backlinks.get(`piece:${A}#p0`) ?? []).map((link) => link.file),
      ).not.toContain("families/quiet-editorial.json");
      expect(after.index.backlinks.get("family:quiet-editorial")?.[0]?.state).toBe("dangling");
    });
  });

  it("a deleted reference leaves the index, and the links to it dangle", async () => {
    await withGoldenCopy(async (dir) => {
      const library = await open(dir, undefined, settled);
      await snap(library);
      await rm(pathOf(dir, `references/${A}.json`));
      const after = await snap(library);
      expect(after.index.references.has(A)).toBe(false);
      expect(after.index.familiesOf.get(`${A}#p0`)).toBeUndefined();
      expect(after.index.backlinks.get(`piece:${A}#p0`)?.every((l) => l.state === "dangling")).toBe(
        true,
      );
    });
  });

  it("a file replaced by a rename, as git checkout does", async () => {
    await withGoldenCopy(async (dir, base) => {
      const library = await open(dir, undefined, settled);
      expect((await snap(library)).index.references.get(D)?.state).toBe("processed");
      const value = JSON.parse(await readFile(pathOf(dir, `references/${D}.json`), "utf8"));
      value.interpretations.p0.status = "accepted";
      value.interpretations.p0.reviewedAt = "2026-11-05T09:00:00.000Z";
      const staged = join(base, "staged.json");
      await writeFile(staged, `${JSON.stringify(value, null, 2)}\n`);
      await rename(staged, pathOf(dir, `references/${D}.json`));
      expect((await snap(library)).index.references.get(D)?.state).toBe("reviewed");
    });
  });

  it("a file that becomes invalid gets its status and leaves the index", async () => {
    await withGoldenCopy(async (dir) => {
      const library = await open(dir, undefined, settled);
      await snap(library);
      await writeFile(pathOf(dir, `references/${A}.json`), "{");
      const after = await snap(library);
      expect(after.files.get(`references/${A}.json`)?.status).toBe("invalid");
      expect(after.index.references.has(A)).toBe(false);
      expect(
        after.index.backlinks.get(`piece:${A}#p0`)?.every((l) => l.state === "unresolved"),
      ).toBe(true);
    });
  });

  it("a folder that can no longer be listed makes the links into it unresolved", async () => {
    await withGoldenCopy(async (dir) => {
      let locked = false;
      const list = (async (path: string, options: never) => {
        if (locked && path === join(dir, "families")) {
          throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
        }
        return readdir(path, options);
      }) as typeof readdir;
      const library = await open(dir, undefined, { ...settled, readdir: list });
      expect((await snap(library)).index.backlinks.get("family:quiet-editorial")?.[0]?.state).toBe(
        "resolved",
      );
      locked = true;
      const after = await snap(library);
      expect(after.unlistedFolders).toEqual(["families"]);
      expect(after.index.backlinks.get("family:quiet-editorial")?.[0]?.state).toBe("unresolved");
      expect(after.index.families.size).toBe(0);
    });
  });
});

describe("the unsettled window", () => {
  /** Opens with `glossary.json` given an mtime two hours ago and the clock `offset` after it. */
  async function setUp(dir: string, offsetMs: number) {
    const file = pathOf(dir, "glossary.json");
    const old = Math.floor(Date.now() / 1000) - 7200;
    await utimes(file, old, old);
    const hooks = frozenStats();
    const library = await open(dir, undefined, {
      stat: hooks.stat,
      statClock: () => old * 1000 + offsetMs,
    });
    // The file changes, but `stat` keeps answering with its old fingerprint.
    hooks.frozen.set(file, await stat(file, { bigint: true }));
    await rewriteSameSize(file, "little noise.", "little noize.");
    return library;
  }

  const definition = async (library: Library): Promise<string> =>
    parsed(await snap(library), "glossary.json").terms[0].entry.content.definition;

  it("reads a file again while it is unsettled, whatever its fingerprint", async () => {
    await withGoldenCopy(async (dir) => {
      const library = await setUp(dir, 1_000);
      expect(await definition(library)).toBe("Much information, little noize.");
    });
  });

  it("trusts the fingerprint of a settled file (so the cache is used)", async () => {
    await withGoldenCopy(async (dir) => {
      const library = await setUp(dir, HOUR);
      expect(await definition(library)).toBe("Much information, little noise.");
    });
  });

  it("does not count an mtime in the future as unsettled", async () => {
    await withGoldenCopy(async (dir) => {
      const library = await setUp(dir, -HOUR);
      expect(await definition(library)).toBe("Much information, little noise.");
    });
  });
});

describe("the cache", () => {
  it("reads nothing when nothing changed, and returns the same snapshot", async () => {
    await withGoldenCopy(async (dir) => {
      const counted = countingReads();
      const library = await open(dir, undefined, { ...settled, readFile: counted.readFile });
      expect(counted.reads.length).toBeGreaterThan(5);
      counted.reads.length = 0;
      const first = await snap(library);
      const second = await snap(library);
      expect(second).toBe(first);
      expect(counted.reads).toEqual([]);
    });
  });

  it("reads only the file that changed", async () => {
    await withGoldenCopy(async (dir) => {
      const counted = countingReads();
      const library = await open(dir, undefined, { ...settled, readFile: counted.readFile });
      const first = await snap(library);
      counted.reads.length = 0;
      await editJson(dir, `references/${B}.json`, (value) => {
        value.note = "Seen at last.";
      });
      const second = await snap(library);
      expect(counted.reads).toEqual([`references/${B}.json`]);
      expect(second).not.toBe(first);
      expect(second.files.get("glossary.json")).toBe(first.files.get("glossary.json"));
    });
  });

  it("returns the same snapshot when a file still cannot be read", async () => {
    await withGoldenCopy(async (dir) => {
      // Injected, so it behaves the same on every system: the read fails without stats, as an
      // EACCES on open or a path that is not a regular file does.
      const readFileHook: OpenOptions["readFile"] = async (path, file) =>
        file === "glossary.json"
          ? {
              status: "failed",
              issue: makeIssue("unreadable-file", file, null, "The file cannot be read (EACCES)."),
            }
          : readLibraryFileBytes(path, file);
      const library = await open(dir, undefined, { ...settled, readFile: readFileHook });
      const first = await snap(library);
      expect(first.files.get("glossary.json")?.status).toBe("unreadable");
      expect(await snap(library)).toBe(first);
      await expectMatchesRebuild(library, dir, { ...settled, readFile: readFileHook });
    });
  });

  it("returns the same snapshot when an unsettled file is still too large", async () => {
    await withGoldenCopy(async (dir) => {
      const file = pathOf(dir, "glossary.json");
      const stats = await stat(file, { bigint: true });
      // Injected: the read reports the file too large, with the stats of its handle.
      const readFileHook: OpenOptions["readFile"] = async (path, relative) =>
        relative === "glossary.json"
          ? {
              status: "failed",
              stats,
              issue: makeIssue("file-too-large", relative, null, "Too large."),
            }
          : readLibraryFileBytes(path, relative);
      // One second after its mtime: the file is unsettled, so every refresh reads it again.
      const unsettled = { statClock: () => Number(stats.mtimeNs / 1_000_000n) + 1_000 };
      const library = await open(dir, undefined, { ...unsettled, readFile: readFileHook });
      const first = await snap(library);
      expect(first.files.get("glossary.json")?.status).toBe("unreadable");
      expect(await snap(library)).toBe(first);
      await expectMatchesRebuild(library, dir, { ...unsettled, readFile: readFileHook });
    });
  });
});

describe("requests and refreshes", () => {
  it("two requests made together share one refresh", async () => {
    await withGoldenCopy(async (dir) => {
      let listings = 0;
      const list = (async (path: string, options: never) => {
        if (path === join(dir)) listings += 1;
        return readdir(path, options);
      }) as typeof readdir;
      const library = await open(dir, undefined, { readdir: list });
      listings = 0;
      const [a, b] = await Promise.all([library.snapshot(), library.snapshot()]);
      expect(listings).toBe(1);
      expect(a).toBe(b);
    });
  });

  it("a request that arrives while a refresh runs is answered by a later refresh", async () => {
    await withGoldenCopy(async (dir) => {
      let pause: Promise<void> | null = null;
      let reached: () => void = () => undefined;
      const atPause = new Promise<void>((resolve) => {
        reached = resolve;
      });
      const readFileHook: OpenOptions["readFile"] = async (path, file) => {
        const result = await readLibraryFileBytes(path, file);
        if (file === "glossary.json" && pause !== null) {
          reached();
          await pause;
        }
        return result;
      };
      const hooks = frozenStats();
      const library = await open(dir, undefined, {
        ...settled,
        stat: hooks.stat,
        readFile: readFileHook,
      });
      let release: () => void = () => undefined;
      pause = new Promise<void>((resolve) => {
        release = resolve;
      });
      // Another inode makes the running refresh read glossary.json instead of trusting it.
      const file = pathOf(dir, "glossary.json");
      const old = await stat(file, { bigint: true });
      hooks.frozen.set(file, { ...old, ino: old.ino + 1n } as BigIntStats);
      const early = library.snapshot();
      await atPause; // the running refresh has read glossary.json
      hooks.frozen.delete(file);
      pause = null;
      await editJson(dir, "glossary.json", (value) => {
        value.terms[0].entry.content.definition = "Changed while a refresh ran.";
      });
      const late = library.snapshot();
      release();
      const [before, after] = await Promise.all([early, late]);
      if (!before.ok || !after.ok) throw new Error("not a library");
      const definitionOf = (s: Snapshot) =>
        parsed(s, "glossary.json").terms[0].entry.content.definition;
      expect(definitionOf(before.snapshot)).toBe("Much information, little noise.");
      expect(definitionOf(after.snapshot)).toBe("Changed while a refresh ran.");
    });
  });
});

describe("after a write through the handle", () => {
  const editGlossary = (library: Library) =>
    library.write(
      (snapshot) => {
        const value = structuredClone(snapshot.files.get("glossary.json")?.value) as Json;
        value.terms[0].entry.content.definition = "Written through the handle.";
        return { changes: [{ path: "glossary.json", next: value }], skipped: [] };
      },
      { clock },
    );

  it("reads the written file back once and shows its bytes", async () => {
    await withGoldenCopy(async (dir) => {
      const counted = countingReads();
      const library = await open(dir, undefined, { ...settled, readFile: counted.readFile });
      expect((await editGlossary(library)).status).toBe("written");
      counted.reads.length = 0;
      const after = await snap(library);
      expect(counted.reads).toEqual(["glossary.json"]);
      const onDisk = new Uint8Array(await readFile(pathOf(dir, "glossary.json")));
      expect(after.files.get("glossary.json")?.bytes).toEqual(onDisk);
      counted.reads.length = 0;
      expect(await snap(library)).toBe(after);
      expect(counted.reads).toEqual([]);
    });
  });

  it("shows its own write even when stat cannot tell the file changed (a coarse mtime, the same size)", async () => {
    await withGoldenCopy(async (dir) => {
      const file = pathOf(dir, "glossary.json");
      const hooks = frozenStats();
      const counted = countingReads();
      const library = await open(dir, undefined, {
        ...settled,
        stat: hooks.stat,
        readFile: counted.readFile,
      });
      // As on a drive with 2-second times: the write keeps the size and the mtime.
      hooks.frozen.set(file, await stat(file, { bigint: true }));
      const result = await library.write(
        (snapshot) => {
          const value = structuredClone(snapshot.files.get("glossary.json")?.value) as Json;
          value.terms[0].entry.content.definition = "Much information, little noize.";
          return { changes: [{ path: "glossary.json", next: value }], skipped: [] };
        },
        { clock },
      );
      expect(result.status).toBe("written");
      counted.reads.length = 0;
      const glossary = parsed(await snap(library), "glossary.json");
      expect(glossary.terms[0].entry.content.definition).toBe("Much information, little noize.");
      expect(counted.reads).toEqual(["glossary.json"]);
    });
  });

  it("does not trust what a refresh read before a write that ended while it ran", async () => {
    await withGoldenCopy(async (dir) => {
      const file = pathOf(dir, "glossary.json");
      const hooks = frozenStats();
      let pause: Promise<void> | null = null;
      let reached: () => void = () => undefined;
      const readFileHook: OpenOptions["readFile"] = async (path, relative) => {
        const read = await readLibraryFileBytes(path, relative);
        if (relative === "glossary.json" && pause !== null) {
          reached();
          await pause;
        }
        return read;
      };
      const library = await open(dir, undefined, {
        ...settled,
        stat: hooks.stat,
        readFile: readFileHook,
      });
      const old = await stat(file, { bigint: true });
      let release: () => void = () => undefined;
      let racing: Promise<unknown> = Promise.resolve();
      const result = await library.write(
        (snapshot) => {
          const value = structuredClone(snapshot.files.get("glossary.json")?.value) as Json;
          value.terms[0].entry.content.definition = "Much information, little noize.";
          return { changes: [{ path: "glossary.json", next: value }], skipped: [] };
        },
        {
          clock,
          at: async (point) => {
            if (point !== "checked") return;
            // Another request refreshes and reads the old bytes just before the rename (its
            // stat answers with another inode, so it reads the file instead of trusting it).
            pause = new Promise<void>((resolve) => {
              release = resolve;
            });
            const atPause = new Promise<void>((resolve) => {
              reached = resolve;
            });
            hooks.frozen.set(file, { ...old, ino: old.ino + 1n } as BigIntStats);
            racing = library.snapshot();
            await atPause;
            // As on a drive with 2-second times: the write keeps the size and the mtime.
            hooks.frozen.set(file, old);
          },
        },
      );
      expect(result.status).toBe("written");
      pause = null;
      release();
      await racing;
      const glossary = parsed(await snap(library), "glossary.json");
      expect(glossary.terms[0].entry.content.definition).toBe("Much information, little noize.");
    });
  });

  it("sees a same-size rewrite by someone else right after it, within the same mtime tick", async () => {
    await withGoldenCopy(async (dir) => {
      const file = pathOf(dir, "glossary.json");
      const hooks = frozenStats();
      const library = await open(dir, undefined, { ...settled, stat: hooks.stat });
      expect((await editGlossary(library)).status).toBe("written");
      // Another writer replaces the file at once; `stat` keeps answering with what the write left.
      hooks.frozen.set(file, await stat(file, { bigint: true }));
      await rewriteSameSize(file, "Written through", "Written by some");
      const glossary = parsed(await snap(library), "glossary.json");
      expect(glossary.terms[0].entry.content.definition).toBe("Written by some the handle.");
    });
  });
});

describe(".tastelib/", () => {
  it("is never created, and adding or deleting it changes nothing", async () => {
    await withGoldenCopy(async (dir) => {
      const library = await open(dir, undefined, settled);
      const first = await snap(library);
      const result = await library.write(
        (snapshot) => {
          const value = structuredClone(snapshot.files.get("glossary.json")?.value) as Json;
          value.terms[0].entry.content.definition = "Changed.";
          return { changes: [{ path: "glossary.json", next: value }], skipped: [] };
        },
        { clock },
      );
      expect(result.status).toBe("written");
      expect(existsSync(join(dir, ".tastelib"))).toBe(false);
      expect(Object.keys(await tree(dir)).some((path) => path.startsWith(".tastelib"))).toBe(false);
      const written = await snap(library);
      expect(written).not.toBe(first);
      await mkdir(join(dir, ".tastelib", "cache"), { recursive: true });
      await writeFile(join(dir, ".tastelib", "cache", "index.json"), "not json");
      await writeFile(join(dir, ".tastelib", "junk"), "x");
      expect(await snap(library)).toBe(written);
      await rm(join(dir, ".tastelib"), { recursive: true });
      expect(await snap(library)).toBe(written);
    });
  });
});
