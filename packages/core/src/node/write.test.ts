import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withTempDir } from "@tastelib/testkit";
import { describe, expect, it } from "vitest";
import { editJson, GOLDEN_V1, withGoldenCopy } from "../../test/support/golden.js";
import { TEST_REGISTRY } from "../../test/support/registry.js";
import { expectMatchesRebuild } from "../../test/support/rebuild.js";
import { FORMAT_REGISTRY } from "../browser.js";
import { currentLayout } from "../format.js";
import { type Library, openLibrary } from "./open.js";
import type { LibraryWriteOptions, WriteResult } from "./write.js";
import { kindOfPath } from "./write.js";

// biome-ignore lint/suspicious/noExplicitAny: tests read and edit arbitrary JSON
type Json = any;

const A = "ref-20261101-a1b2c3";
const G = "ref-20261103-g7h8j9";
const MISSING = "ref-20261230-b1c2d3";
const NOW = new Date("2026-11-05T10:00:00.000Z");
const clock = () => NOW;

async function open(library: string, registry = FORMAT_REGISTRY): Promise<Library> {
  const opened = await openLibrary(library, { registry });
  if (!opened.ok) throw new Error(opened.message);
  return opened.library;
}

/** Every file under `dir` with its bytes, to prove a refusal changed nothing, folders included. */
async function tree(dir: string, prefix = ""): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const entry of await readdir(join(dir, prefix), { withFileTypes: true })) {
    const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      out[`${path}/`] = "";
      Object.assign(out, await tree(dir, path));
    } else {
      out[path] = await readFile(join(dir, path), "utf8");
    }
  }
  return out;
}

async function json(library: string, path: string): Promise<Json> {
  return JSON.parse(await readFile(join(library, ...path.split("/")), "utf8"));
}

/** Edits the current value of `path` (a clone) and writes it. */
async function edit(
  library: Library,
  path: string,
  change: (value: Json) => void,
  options: LibraryWriteOptions = { clock },
): Promise<WriteResult> {
  return library.write((snapshot) => {
    const file = snapshot.files.get(path);
    if (file === undefined) throw new Error(`no ${path}`);
    const next = structuredClone(file.value);
    change(next);
    return { changes: [{ path, next }], skipped: [] };
  }, options);
}

/** The library as it is on disk now has no error and no warning. */
async function expectClean(library: string): Promise<void> {
  const opened = await openLibrary(library);
  if (!opened.ok) throw new Error(opened.message);
  const snapshot = await opened.library.snapshot();
  if (!snapshot.ok) throw new Error(snapshot.message);
  expect(snapshot.snapshot.issues.filter((i) => i.severity !== "info")).toEqual([]);
}

describe("writing a library file", () => {
  it("writes a change canonically and sets the timestamps", async () => {
    await withGoldenCopy(async (dir) => {
      const library = await open(dir);
      const result = await edit(library, "glossary.json", (g) => {
        g.terms[0].entry.content.definition = "Much information, no noise.";
      });
      expect(result).toEqual({
        status: "written",
        written: ["glossary.json"],
        skipped: [],
        notices: [],
      });
      const glossary = await json(dir, "glossary.json");
      expect(glossary.terms[0].updatedAt).toBe(NOW.toISOString());
      expect(glossary.terms[0].createdAt).toBe("2026-11-02T12:00:00.000Z");
      expect(glossary.terms[1].updatedAt).toBe("2026-11-03T12:00:00.000Z");
      await expectClean(dir);
      await expectMatchesRebuild(library, dir);
    });
  });

  it("gives a new entry createdAt and updatedAt of now", async () => {
    await withGoldenCopy(async (dir) => {
      const library = await open(dir);
      await edit(library, "glossary.json", (g) => {
        const term = structuredClone(g.terms[0]);
        term.id = "term-1a2b3c";
        term.entry.content.term = "Another term";
        g.terms.push(term);
      });
      const glossary = await json(dir, "glossary.json");
      const added = glossary.terms.find((t: Json) => t.id === "term-1a2b3c");
      expect(added.createdAt).toBe(NOW.toISOString());
      expect(added.updatedAt).toBe(NOW.toISOString());
      await expectClean(dir);
      await expectMatchesRebuild(library, dir);
    });
  });

  it("creates a new file and the folder it needs, and stamps it", async () => {
    await withGoldenCopy(async (dir) => {
      const library = await open(dir);
      const result = await library.write(
        (snapshot) => {
          const project = structuredClone(
            snapshot.files.get("projects/internal-dashboard/project.json")?.value,
          ) as Json;
          project.slug = "fresh-start";
          project.name = "Fresh start";
          return {
            changes: [{ path: "projects/fresh-start/project.json", next: project }],
            skipped: [],
          };
        },
        { clock },
      );
      expect(result.status).toBe("written");
      const project = await json(dir, "projects/fresh-start/project.json");
      expect(project.createdAt).toBe(NOW.toISOString());
      expect(project.updatedAt).toBe(NOW.toISOString());
      await expectClean(dir);
      await expectMatchesRebuild(library, dir);
    });
  });

  it("refuses an invalid value and leaves every file untouched", async () => {
    await withGoldenCopy(async (dir) => {
      const before = await tree(dir);
      const library = await open(dir);
      const result = await edit(library, "families/quiet-editorial.json", (f) => {
        f.members[0].target = "not a piece";
      });
      expect(result.status).toBe("refused");
      if (result.status !== "refused") return;
      expect(result.issues.length).toBeGreaterThan(0);
      expect(result.issues.every((i) => i.severity === "error")).toBe(true);
      expect(result.issues[0]?.file).toBe("families/quiet-editorial.json");
      expect(await tree(dir)).toEqual(before);
      await expectMatchesRebuild(library, dir);
    });
  });

  it("refuses a file named for another thing", async () => {
    await withGoldenCopy(async (dir) => {
      const before = await tree(dir);
      const library = await open(dir);
      const result = await library.write(
        (snapshot) => ({
          changes: [
            {
              path: "families/other-name.json",
              next: structuredClone(snapshot.files.get("families/quiet-editorial.json")?.value),
            },
          ],
          skipped: [],
        }),
        { clock },
      );
      expect(result).toMatchObject({ status: "refused" });
      if (result.status === "refused") {
        expect(result.issues.map((i) => i.code)).toContain("name-mismatch");
      }
      expect(await tree(dir)).toEqual(before);
    });
  });

  it("refuses a value of another format version", async () => {
    await withGoldenCopy(async (dir) => {
      const library = await open(dir);
      const result = await edit(library, "glossary.json", (g) => {
        g.formatVersion = 0;
      });
      expect(result.status).toBe("refused");
    });
  });

  it("rewrites a non-canonical file canonically on the next real write", async () => {
    await withGoldenCopy(async (dir) => {
      const path = join(dir, "glossary.json");
      const value = JSON.parse(await readFile(path, "utf8"));
      await writeFile(path, `${JSON.stringify(value, null, 4).replaceAll("\n", "\r\n")}\r\n`);
      const library = await open(dir);
      const result = await edit(library, "glossary.json", (g) => {
        g.terms[0].entry.content.definition = "Changed.";
      });
      expect(result.status).toBe("written");
      await expectClean(dir);
      expect(await readFile(path, "utf8")).not.toContain("\r");
    });
  });

  it("does not rewrite a non-canonical file when nothing changes", async () => {
    await withGoldenCopy(async (dir) => {
      const path = join(dir, "glossary.json");
      const value = JSON.parse(await readFile(path, "utf8"));
      await writeFile(path, `${JSON.stringify(value, null, 4)}\n`);
      const before = await readFile(path, "utf8");
      const library = await open(dir);
      const result = await edit(library, "glossary.json", () => undefined);
      expect(result).toEqual({ status: "unchanged", skipped: [], notices: [] });
      expect(await readFile(path, "utf8")).toBe(before);
    });
  });

  it("ends unchanged, moving no timestamp, when the plan changes nothing", async () => {
    await withGoldenCopy(async (dir) => {
      const before = await tree(dir);
      const library = await open(dir);
      expect(await library.write(() => ({ changes: [], skipped: [] }), { clock })).toMatchObject({
        status: "unchanged",
      });
      expect(await edit(library, "families/quiet-editorial.json", () => undefined)).toMatchObject({
        status: "unchanged",
      });
      expect(await tree(dir)).toEqual(before);
    });
  });

  it("passes the plan's skipped files through", async () => {
    await withGoldenCopy(async (dir) => {
      const library = await open(dir);
      const result = await library.write(() => ({
        changes: [],
        skipped: [{ path: "a", reason: "invalid" }],
      }));
      expect(result).toEqual({
        status: "unchanged",
        skipped: [{ path: "a", reason: "invalid" }],
        notices: [],
      });
    });
  });
});

describe("clock skew", () => {
  it("sets updatedAt to createdAt when createdAt is in the future", async () => {
    await withGoldenCopy(async (dir) => {
      const future = "2030-01-01T00:00:00.000Z";
      await editJson(dir, "families/quiet-editorial.json", (f) => {
        f.createdAt = future;
        f.updatedAt = future;
      });
      const library = await open(dir);
      const result = await edit(library, "families/quiet-editorial.json", (f) => {
        f.description.proposal.meaning = "Calm layouts.";
      });
      expect(result.status).toBe("written");
      const family = await json(dir, "families/quiet-editorial.json");
      expect(family.createdAt).toBe(future);
      expect(family.updatedAt).toBe(future);
      await expectClean(dir);
    });
  });
});

describe("links", () => {
  it("refuses a new dangling link and leaves the files untouched", async () => {
    await withGoldenCopy(async (dir) => {
      const before = await tree(dir);
      const library = await open(dir);
      const result = await edit(library, "glossary.json", (g) => {
        g.terms[1].pieces.push(`${MISSING}#p0`);
      });
      expect(result.status).toBe("refused");
      if (result.status !== "refused") return;
      expect(result.issues).toEqual([
        expect.objectContaining({
          severity: "warning",
          code: "dangling-link",
          file: "glossary.json",
          pointer: "/terms/1/pieces/0",
        }),
      ]);
      expect(await tree(dir)).toEqual(before);
    });
  });

  it("refuses a link to a piece a reference does not have", async () => {
    await withGoldenCopy(async (dir) => {
      const library = await open(dir);
      const result = await edit(library, "glossary.json", (g) => {
        g.terms[1].pieces.push(`${A}#p9`);
      });
      expect(result.status).toBe("refused");
    });
  });

  it("keeps a link that was already dangling", async () => {
    await withGoldenCopy(async (dir) => {
      await editJson(dir, "glossary.json", (g) => {
        g.terms[1].pieces.push(`${MISSING}#p0`);
      });
      const library = await open(dir);
      const result = await edit(library, "glossary.json", (g) => {
        g.terms[1].entry.proposal.definition = "Contrast that is felt.";
      });
      expect(result.status).toBe("written");
      const glossary = await json(dir, "glossary.json");
      expect(glossary.terms[1].pieces).toEqual([`${MISSING}#p0`]);
      await expectMatchesRebuild(library, dir);
    });
  });

  it("counts a link as new for each holder: another term linking to the same missing piece is refused", async () => {
    await withGoldenCopy(async (dir) => {
      await editJson(dir, "glossary.json", (g) => {
        g.terms[1].pieces.push(`${MISSING}#p0`);
      });
      const library = await open(dir);
      const result = await edit(library, "glossary.json", (g) => {
        g.terms[0].pieces.push(`${MISSING}#p0`);
      });
      expect(result.status).toBe("refused");
    });
  });

  it("refuses a new link into a file that has errors, naming that file", async () => {
    await withGoldenCopy(async (dir) => {
      await editJson(dir, `references/${G}.json`, (r) => {
        r.source = 5;
      });
      const library = await open(dir);
      const result = await edit(library, "glossary.json", (g) => {
        g.terms[1].pieces.push(`${G}#p0`);
      });
      expect(result.status).toBe("refused");
      if (result.status !== "refused") return;
      expect(result.issues[0]?.code).toBe("dangling-link");
      expect(result.issues[0]?.message).toContain(`references/${G}.json`);
    });
  });

  it("accepts a new link that resolves", async () => {
    await withGoldenCopy(async (dir) => {
      const library = await open(dir);
      const result = await edit(library, "glossary.json", (g) => {
        g.terms[1].pieces.push(`${A}#p0`);
      });
      expect(result.status).toBe("written");
      await expectClean(dir);
      await expectMatchesRebuild(library, dir);
    });
  });
});

describe("the write gate", () => {
  it("refuses every write while a file of a newer format exists", async () => {
    await withGoldenCopy(async (dir) => {
      await editJson(dir, `references/${G}.json`, (r) => {
        r.formatVersion = 99;
      });
      const before = await tree(dir);
      const library = await open(dir);
      const result = await edit(library, "glossary.json", (g) => {
        g.terms[0].entry.content.definition = "Changed.";
      });
      expect(result.status).toBe("refused");
      if (result.status !== "refused") return;
      expect(result.issues.map((i) => [i.code, i.file])).toEqual([
        ["newer-format", `references/${G}.json`],
      ]);
      expect(await tree(dir)).toEqual(before);
    });
  });

  it("gives write-conflict while the migration backup exists", async () => {
    await withGoldenCopy(async (dir) => {
      await mkdir(join(dir, ".tastelib", "migration-backup"), { recursive: true });
      const before = await tree(dir);
      const library = await open(dir);
      const result = await edit(library, "glossary.json", (g) => {
        g.terms[0].entry.content.definition = "Changed.";
      });
      expect(result.status).toBe("refused");
      if (result.status !== "refused") return;
      expect(result.issues.map((i) => i.code)).toEqual(["write-conflict"]);
      expect(await tree(dir)).toEqual(before);
    });
  });

  it("gives write-conflict when the backup appears just before the rename, and removes the temporary file", async () => {
    await withGoldenCopy(async (dir) => {
      const library = await open(dir);
      const result = await edit(
        library,
        "glossary.json",
        (g) => {
          g.terms[0].entry.content.definition = "Changed.";
        },
        {
          clock,
          at: async (point) => {
            if (point === "before-rename") {
              await mkdir(join(dir, ".tastelib", "migration-backup"), { recursive: true });
            }
          },
        },
      );
      expect(result.status).toBe("refused");
      if (result.status === "refused") expect(result.issues[0]?.code).toBe("write-conflict");
      expect((await readdir(dir)).filter((n) => n.includes(".tmp-"))).toEqual([]);
      expect((await json(dir, "glossary.json")).terms[0].entry.content.definition).toBe(
        "Much information, little noise.",
      );
    });
  });

  it("refuses when library.json has errors, with that file's issues", async () => {
    await withGoldenCopy(async (dir) => {
      await editJson(dir, "library.json", (l) => {
        l.id = "nope";
      });
      const before = await tree(dir);
      const library = await open(dir);
      const result = await edit(library, "glossary.json", () => undefined);
      expect(result.status).toBe("refused");
      if (result.status === "refused") {
        expect(result.issues.every((i) => i.file === "library.json")).toBe(true);
      }
      expect(await tree(dir)).toEqual(before);
    });
  });

  it("fails with not-a-library when library.json is gone", async () => {
    await withGoldenCopy(async (dir) => {
      const library = await open(dir);
      await library.snapshot();
      await rm(join(dir, "library.json"));
      const result = await library.write(() => ({ changes: [], skipped: [] }));
      expect(result).toMatchObject({ status: "failed", failure: { code: "not-a-library" } });
    });
  });

  it("refuses an older library until the migration runner exists", async () => {
    await withGoldenCopy(async (dir) => {
      const before = await tree(dir);
      const library = await open(dir, TEST_REGISTRY);
      const result = await library.write(() => ({ changes: [], skipped: [] }), { clock });
      expect(result.status).toBe("refused");
      if (result.status === "refused") {
        expect(result.issues.map((i) => i.code)).toContain("needs-migration");
      }
      expect(await tree(dir)).toEqual(before);
    });
  });

  it("refuses a mixed library until the migration runner exists", async () => {
    await withGoldenCopy(async (dir) => {
      await writeFile(
        join(dir, "library.json"),
        `${JSON.stringify({ formatVersion: 2, anything: true }, null, 2)}\n`,
      );
      const before = await tree(dir);
      const library = await open(dir, TEST_REGISTRY);
      const result = await edit(library, "glossary.json", () => undefined);
      expect(result.status).toBe("refused");
      if (result.status === "refused") {
        expect(result.issues.map((i) => i.code)).toContain("mixed-format-versions");
      }
      expect(await tree(dir)).toEqual(before);
    });
  });

  it("fails with unreadable-folder when the library folder moves after it was opened", async () => {
    await withGoldenCopy(async (dir, base) => {
      const library = await open(dir);
      await rename(dir, join(base, "moved"));
      const result = await edit(library, "glossary.json", (g) => {
        g.terms[0].entry.content.definition = "Changed.";
      });
      expect(result).toMatchObject({ status: "failed", failure: { code: "unreadable-folder" } });
    });
  });

  it("never replaces a file that has errors", async () => {
    await withGoldenCopy(async (dir) => {
      await editJson(dir, "families/quiet-editorial.json", (f) => {
        f.members = "broken";
      });
      const before = await tree(dir);
      const library = await open(dir);
      const snapshot = await openLibrary(dir);
      if (!snapshot.ok) throw new Error(snapshot.message);
      const own = await snapshot.library.snapshot();
      if (!own.ok) throw new Error(own.message);
      const brokenIssues = own.snapshot.files.get("families/quiet-editorial.json")?.issues;
      // A perfectly valid value over the broken file is still refused, with the broken file's own issues.
      const valid = structuredClone(
        JSON.parse(await readFile(join(GOLDEN_V1, "families", "quiet-editorial.json"), "utf8")),
      );
      const result = await library.write(
        () => ({
          changes: [{ path: "families/quiet-editorial.json", next: valid }],
          skipped: [],
        }),
        { clock },
      );
      expect(result).toMatchObject({ status: "refused", issues: brokenIssues });
      expect(await tree(dir)).toEqual(before);
    });
  });
});

describe("concurrent writers", () => {
  it("refuses with write-conflict when the file changes before the rename, leaving the other writer's bytes", async () => {
    await withGoldenCopy(async (dir) => {
      const library = await open(dir);
      const result = await edit(
        library,
        "glossary.json",
        (g) => {
          g.terms[0].entry.content.definition = "Mine.";
        },
        {
          clock,
          at: async (point) => {
            if (point === "before-rename") {
              await editJson(dir, "glossary.json", (g) => {
                g.terms[0].entry.content.definition = "Theirs.";
              });
            }
          },
        },
      );
      expect(result.status).toBe("refused");
      if (result.status === "refused") expect(result.issues[0]?.code).toBe("write-conflict");
      expect((await json(dir, "glossary.json")).terms[0].entry.content.definition).toBe("Theirs.");
      expect((await readdir(dir)).filter((n) => n.includes(".tmp-"))).toEqual([]);
      await expectMatchesRebuild(library, dir);
    });
  });

  it("refuses with write-conflict when a file appears where there was none", async () => {
    await withGoldenCopy(async (dir) => {
      const library = await open(dir);
      const result = await library.write(
        (snapshot) => {
          const project = structuredClone(
            snapshot.files.get("projects/internal-dashboard/project.json")?.value,
          ) as Json;
          project.slug = "fresh-start";
          return {
            changes: [{ path: "projects/fresh-start/project.json", next: project }],
            skipped: [],
          };
        },
        {
          clock,
          at: async (point) => {
            if (point === "before-rename") {
              await writeFile(join(dir, "projects", "fresh-start", "project.json"), "{}");
            }
          },
        },
      );
      expect(result.status).toBe("refused");
    });
  });

  it("removes the folder it made when a backup appears before the rename of a new file", async () => {
    await withGoldenCopy(async (dir) => {
      const library = await open(dir);
      const result = await library.write(
        (snapshot) => {
          const project = structuredClone(
            snapshot.files.get("projects/internal-dashboard/project.json")?.value,
          ) as Json;
          project.slug = "fresh-start";
          return {
            changes: [{ path: "projects/fresh-start/project.json", next: project }],
            skipped: [],
          };
        },
        {
          clock,
          at: async (point) => {
            if (point === "before-rename") {
              await mkdir(join(dir, ".tastelib", "migration-backup"), { recursive: true });
            }
          },
        },
      );
      expect(result).toMatchObject({
        status: "refused",
        notWritten: ["projects/fresh-start/project.json"],
      });
      expect(await readdir(join(dir, "projects"))).not.toContain("fresh-start");
    });
  });

  it("runs writes through one handle one at a time, each on the result of the last", async () => {
    await withGoldenCopy(async (dir) => {
      const library = await open(dir);
      const add = (id: string, term: string) =>
        edit(library, "glossary.json", (g) => {
          const entry = structuredClone(g.terms[0]);
          entry.id = id;
          entry.entry.content.term = term;
          g.terms.push(entry);
        });
      const results = await Promise.all([add("term-1a1a1a", "One"), add("term-2b2b2b", "Two")]);
      expect(results.map((r) => r.status)).toEqual(["written", "written"]);
      const ids = (await json(dir, "glossary.json")).terms.map((t: Json) => t.id);
      expect(ids).toContain("term-1a1a1a");
      expect(ids).toContain("term-2b2b2b");
      await expectClean(dir);
      await expectMatchesRebuild(library, dir);
    });
  });
});

describe("refusals", () => {
  it("lists the issues sorted by file, pointer and code", async () => {
    await withGoldenCopy(async (dir) => {
      const library = await open(dir);
      const result = await edit(library, "families/quiet-editorial.json", (family) => {
        family.members = "x";
        family.updatedAt = "x";
      });
      if (result.status !== "refused") throw new Error("not refused");
      expect(result.issues.map((i) => [i.pointer, i.code])).toEqual([
        ["/members", "schema-violation"],
        ["/updatedAt", "schema-violation"],
      ]);
    });
  });

  it("refuses a valid value of an older format version when the tool writes a newer one", async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, "library.json"), `${JSON.stringify({ formatVersion: 2 })}\n`);
      const library = await open(dir, TEST_REGISTRY);
      const result = await library.write(
        () => ({
          changes: [{ path: "glossary.json", next: { formatVersion: 1, terms: [] } }],
          skipped: [],
        }),
        { clock },
      );
      if (result.status !== "refused") throw new Error("not refused");
      expect(result.issues.map((i) => [i.code, i.pointer])).toEqual([
        ["schema-violation", "/formatVersion"],
      ]);
      expect(await readdir(dir)).toEqual(["library.json"]);
    });
  });

  it("reports a link into a folder that could not be listed as unchecked, not missing", async () => {
    await withGoldenCopy(async (dir) => {
      const opened = await openLibrary(dir, {
        readdir: (async (path: string, ...rest: unknown[]) => {
          if (path.endsWith("references")) {
            throw Object.assign(new Error("denied"), { code: "EACCES" });
          }
          // biome-ignore lint/suspicious/noExplicitAny: forwards the real call
          return (readdir as any)(path, ...rest);
        }) as typeof readdir,
      });
      if (!opened.ok) throw new Error(opened.message);
      const result = await edit(opened.library, "glossary.json", (g) => {
        g.terms[1].pieces.push(`${A}#p0`);
      });
      if (result.status !== "refused") throw new Error("not refused");
      expect(result.issues[0]?.message).toContain("cannot be checked");
    });
  });
});

describe("failures", () => {
  it("returns io-error, not a throw, when the file cannot be written", async () => {
    await withGoldenCopy(async (dir) => {
      const library = await open(dir);
      const result = await edit(
        library,
        "glossary.json",
        (g) => {
          g.terms[0].entry.content.definition = "Changed.";
        },
        {
          clock,
          fs: {
            ...(await import("node:fs/promises")),
            rename: async () => {
              throw Object.assign(new Error("denied"), { code: "EACCES" });
            },
          },
          platform: "linux",
        },
      );
      expect(result).toMatchObject({
        status: "failed",
        failure: { code: "io-error", operation: "rename", file: "glossary.json", errno: "EACCES" },
        written: [],
        notWritten: ["glossary.json"],
      });
      expect((await readdir(dir)).filter((n) => n.includes(".tmp-"))).toEqual([]);
      await expectMatchesRebuild(library, dir);
    });
  });
});

describe("paths", () => {
  it("knows the files of the format and nothing else", () => {
    const layout = currentLayout(FORMAT_REGISTRY);
    expect(kindOfPath(layout, "glossary.json")).toBe("glossary");
    expect(kindOfPath(layout, `references/${A}.json`)).toBe("reference");
    expect(kindOfPath(layout, "projects/landing-redesign/directions.json")).toBe("directions");
    expect(kindOfPath(layout, "projects/../directions.json")).toBeNull();
    expect(kindOfPath(layout, "projects/Not A Slug/directions.json")).toBeNull();
    expect(kindOfPath(layout, "references/.x.json.tmp-abcdefgh")).toBeNull();
    expect(kindOfPath(layout, "notes.txt")).toBeNull();
    expect(kindOfPath(layout, "references//x.json")).toBeNull();
  });

  it("throws, as a bug, for a path that is not a file of the format", async () => {
    await withGoldenCopy(async (dir) => {
      const library = await open(dir);
      await expect(
        library.write(() => ({ changes: [{ path: "../outside.json", next: {} }], skipped: [] })),
      ).rejects.toThrow();
    });
  });
});
