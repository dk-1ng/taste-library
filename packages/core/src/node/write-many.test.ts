import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { crashAt, recordPoints, SimulatedCrash } from "../../test/support/crash.js";
import { editJson, withGoldenCopy } from "../../test/support/golden.js";
import {
  issuesOnDisk,
  type Json,
  open,
  readJson,
  temporaryFiles,
  tree,
} from "../../test/support/library.js";
import type { FileChange, Plan } from "../changes/plan.js";
import type { Snapshot } from "../validation/library.js";
import { type FileSystem, realFileSystem } from "./replace-file.js";
import type { LibraryWriteOptions } from "./write.js";

/**
 * The write pipeline with several files (docs/design.md section 4, "Writing library files";
 * format-spec §5): every target checked before the first rename, the plan written in order, and
 * the files written and not written reported when it stops partway.
 */

const A = "ref-20261101-a1b2c3";
const D = "ref-20261102-d4e5f6";
const NEW = "ref-20261105-x1y2z3";
const NOW = new Date("2026-11-05T10:00:00.000Z");
const clock = () => NOW;

const GLOSSARY = "glossary.json";
const FAMILY = "families/quiet-editorial.json";
const PROFILE = "taste-profile.json";
const THREE = [GLOSSARY, FAMILY, PROFILE];
const SKIPPED = [{ path: "families/broken.json", reason: "invalid" as const }];

function copyOf(snapshot: Snapshot, path: string): Json {
  const file = snapshot.files.get(path);
  if (file === undefined) throw new Error(`no ${path}`);
  return structuredClone(file.value);
}

/** Three real changes, in this order: a glossary term, a family and a statement. */
function three(snapshot: Snapshot, skipped = SKIPPED): Plan {
  const glossary = copyOf(snapshot, GLOSSARY);
  glossary.terms[0].entry.content.definition = "Changed by a multi-file write.";
  const family = copyOf(snapshot, FAMILY);
  family.description.proposal.meaning = "Changed by a multi-file write.";
  const profile = copyOf(snapshot, PROFILE);
  profile.statements[0].statement.content.text = "Changed by a multi-file write.";
  return {
    changes: [
      { path: GLOSSARY, next: glossary },
      { path: FAMILY, next: family },
      { path: PROFILE, next: profile },
    ],
    skipped,
  };
}

/** A copy of reference D under a new id, as a new reference. */
function newReference(snapshot: Snapshot): Json {
  const reference = copyOf(snapshot, `references/${D}.json`);
  reference.id = NEW;
  reference.media[0].file = `${NEW}/m1.png`;
  return reference;
}

const changed = (text: string) => text.includes("Changed by a multi-file write.");

/** Whether each of the three files holds the change, in plan order. */
async function which(dir: string): Promise<boolean[]> {
  return Promise.all(
    THREE.map(async (path) => changed(await readFile(join(dir, ...path.split("/")), "utf8"))),
  );
}

/** A file system whose `rename` fails with `code` for targets ending in `suffix`. */
function failingRename(suffix: string, code: string): FileSystem {
  return {
    ...realFileSystem,
    rename: async (from, to) => {
      if (String(to).endsWith(suffix))
        throw Object.assign(new Error(`${code}: injected`), { code });
      return realFileSystem.rename(from, to);
    },
  };
}

describe("a write of several files", () => {
  it("writes every change in plan order, with the named points", async () => {
    await withGoldenCopy(async (dir) => {
      const library = await open(dir);
      const { points, at } = recordPoints();
      const result = await library.write(three, { clock, at });
      expect(result).toEqual({
        status: "written",
        written: THREE,
        skipped: SKIPPED,
        notices: [],
      });
      expect(points).toEqual([
        "checked",
        ...THREE.flatMap((path) => ["temp-written", "before-rename", `wrote:${path}`]),
      ]);
      expect(await which(dir)).toEqual([true, true, true]);
      expect(await issuesOnDisk(dir)).toEqual([]);
    });
  });

  it("deletes a file, with the deletion points", async () => {
    await withGoldenCopy(async (dir) => {
      const library = await open(dir);
      const { points, at } = recordPoints();
      const path = `references/${D}.json`;
      const result = await library.write(() => ({ changes: [{ path, next: null }], skipped: [] }), {
        clock,
        at,
      });
      expect(result).toEqual({ status: "written", written: [path], skipped: [], notices: [] });
      expect(points).toEqual(["checked", "before-unlink", `deleted:${path}`]);
      expect(Object.keys(await tree(dir))).not.toContain(path);
      expect(await issuesOnDisk(dir)).toEqual([]);
    });
  });

  it("uses one time for every file it stamps", async () => {
    await withGoldenCopy(async (dir) => {
      const library = await open(dir);
      let calls = 0;
      const ticking = () => new Date(NOW.getTime() + 1000 * calls++);
      expect((await library.write(three, { clock: ticking })).status).toBe("written");
      expect(calls).toBe(1);
      expect((await readJson(dir, GLOSSARY)).terms[0].updatedAt).toBe(NOW.toISOString());
      expect((await readJson(dir, FAMILY)).updatedAt).toBe(NOW.toISOString());
      expect((await readJson(dir, PROFILE)).statements[0].updatedAt).toBe(NOW.toISOString());
    });
  });

  it("drops the changes that change nothing and writes the rest", async () => {
    await withGoldenCopy(async (dir) => {
      const path = join(dir, GLOSSARY);
      // Not canonical, so a rewrite would show.
      await writeFile(
        path,
        `${JSON.stringify(JSON.parse(await readFile(path, "utf8")), null, 4)}\n`,
      );
      const before = await readFile(path, "utf8");
      const library = await open(dir);
      const { points, at } = recordPoints();
      const result = await library.write(
        (snapshot) => {
          const plan = three(snapshot);
          plan.changes[0] = { path: GLOSSARY, next: copyOf(snapshot, GLOSSARY) };
          return plan;
        },
        { clock, at },
      );
      expect(result).toMatchObject({ status: "written", written: [FAMILY, PROFILE] });
      expect(points).not.toContain(`wrote:${GLOSSARY}`);
      expect(await readFile(path, "utf8")).toBe(before);
    });
  });

  it("ends unchanged when no change changes anything, passing skipped through", async () => {
    await withGoldenCopy(async (dir) => {
      const before = await tree(dir);
      const library = await open(dir);
      const result = await library.write(
        (snapshot) => ({
          changes: THREE.map((path) => ({ path, next: copyOf(snapshot, path) })),
          skipped: SKIPPED,
        }),
        { clock },
      );
      expect(result).toEqual({ status: "unchanged", skipped: SKIPPED, notices: [] });
      expect(await tree(dir)).toEqual(before);
    });
  });
});

describe("refusals before anything is written", () => {
  it("refuses the whole write when any change is invalid, with its issues", async () => {
    await withGoldenCopy(async (dir) => {
      const before = await tree(dir);
      const library = await open(dir);
      const result = await library.write(
        (snapshot) => {
          const plan = three(snapshot);
          (plan.changes[2] as FileChange & { next: Json }).next.statements = "broken";
          return plan;
        },
        { clock },
      );
      expect(result).toMatchObject({
        status: "refused",
        written: [],
        notWritten: [],
        skipped: SKIPPED,
      });
      if (result.status !== "refused") return;
      expect(result.issues.map((i) => [i.file, i.code])).toEqual([[PROFILE, "schema-violation"]]);
      expect(await tree(dir)).toEqual(before);
    });
  });

  it("refuses the whole write when a later file has errors, with that file's issues", async () => {
    await withGoldenCopy(async (dir) => {
      await editJson(dir, PROFILE, (profile) => {
        profile.statements = "broken";
      });
      const before = await tree(dir);
      const library = await open(dir);
      const glossaryOnly = (snapshot: Snapshot): Plan => {
        const glossary = copyOf(snapshot, GLOSSARY);
        glossary.terms[0].entry.content.definition = "Changed by a multi-file write.";
        return {
          changes: [
            { path: GLOSSARY, next: glossary },
            { path: PROFILE, next: { formatVersion: 1, statements: [] } },
          ],
          skipped: [],
        };
      };
      const result = await library.write(glossaryOnly, { clock });
      expect(result).toMatchObject({ status: "refused", written: [], notWritten: [] });
      if (result.status !== "refused") return;
      expect(result.issues.length).toBeGreaterThan(0);
      expect(result.issues.every((i) => i.file === PROFILE)).toBe(true);
      expect(await tree(dir)).toEqual(before);
    });
  });

  it("refuses with the issues of a file the plan is blocked by, and writes when it is valid", async () => {
    await withGoldenCopy(async (dir) => {
      await editJson(dir, "guardrails.json", (guardrails) => {
        guardrails.guardrails = 7;
      });
      const before = await tree(dir);
      const library = await open(dir);
      const blocked = await library.write(
        (snapshot) => ({ ...three(snapshot), blockedBy: ["guardrails.json"] }),
        { clock },
      );
      expect(blocked).toMatchObject({ status: "refused", written: [], notWritten: [] });
      if (blocked.status !== "refused") return;
      expect(blocked.issues.length).toBeGreaterThan(0);
      expect(blocked.issues.every((i) => i.file === "guardrails.json")).toBe(true);
      expect(await tree(dir)).toEqual(before);

      const passes = await library.write(
        (snapshot) => ({ ...three(snapshot), blockedBy: [`references/${A}.json`] }),
        { clock },
      );
      expect(passes.status).toBe("written");
    });
  });

  it("refuses with the folder's issue when a file it is blocked by lies in a folder that cannot be listed", async () => {
    await withGoldenCopy(async (dir) => {
      const { readdir } = await import("node:fs/promises");
      const library = await open(dir, undefined, {
        readdir: (async (path: string, ...rest: unknown[]) => {
          if (path.endsWith("families")) {
            throw Object.assign(new Error("denied"), { code: "EACCES" });
          }
          // biome-ignore lint/suspicious/noExplicitAny: forwards the real call
          return (readdir as any)(path, ...rest);
        }) as typeof readdir,
      });
      const result = await library.write(
        (snapshot) => {
          const glossary = copyOf(snapshot, GLOSSARY);
          glossary.terms[0].entry.content.definition = "Changed by a multi-file write.";
          return {
            changes: [{ path: GLOSSARY, next: glossary }],
            skipped: [],
            blockedBy: [FAMILY],
          };
        },
        { clock },
      );
      expect(result).toMatchObject({ status: "refused", written: [], notWritten: [] });
      if (result.status !== "refused") return;
      expect(result.issues.map((i) => [i.file, i.code])).toEqual([["families", "unreadable-file"]]);
    });
  });

  it("judges new links on the library with the whole plan applied", async () => {
    await withGoldenCopy(async (dir) => {
      const before = await tree(dir);
      const library = await open(dir);
      // A link to a reference the same plan deletes is new and dangling.
      const refused = await library.write(
        (snapshot) => {
          const glossary = copyOf(snapshot, GLOSSARY);
          glossary.terms[1].pieces.push(`${D}#p0`);
          return {
            changes: [
              { path: `references/${D}.json`, next: null },
              { path: GLOSSARY, next: glossary },
            ],
            skipped: [],
          };
        },
        { clock },
      );
      expect(refused).toMatchObject({ status: "refused", written: [], notWritten: [] });
      if (refused.status !== "refused") return;
      expect(refused.issues.map((i) => [i.file, i.code, i.pointer])).toEqual([
        [GLOSSARY, "dangling-link", "/terms/1/pieces/0"],
      ]);
      expect(await tree(dir)).toEqual(before);

      // A link to a reference the same plan creates resolves.
      const written = await library.write(
        (snapshot) => {
          const glossary = copyOf(snapshot, GLOSSARY);
          glossary.terms[1].pieces.push(`${NEW}#p0`);
          return {
            changes: [
              { path: `references/${NEW}.json`, next: newReference(snapshot) },
              { path: GLOSSARY, next: glossary },
            ],
            skipped: [],
          };
        },
        { clock },
      );
      expect(written).toMatchObject({
        status: "written",
        written: [`references/${NEW}.json`, GLOSSARY],
      });
    });
  });

  it("refuses the whole write when any target changed before the first rename", async () => {
    await withGoldenCopy(async (dir) => {
      const library = await open(dir);
      const { points, at } = recordPoints();
      const result = await library.write(
        async (snapshot) => {
          // Another writer changes the last file after the snapshot was read.
          await editJson(dir, PROFILE, (profile) => {
            profile.statements[1].statement.proposal.text = "Theirs.";
          });
          return three(snapshot);
        },
        { clock, at },
      );
      expect(result).toMatchObject({
        status: "refused",
        written: [],
        notWritten: THREE,
        skipped: SKIPPED,
      });
      if (result.status !== "refused") return;
      expect(result.issues.map((i) => [i.file, i.code])).toEqual([[PROFILE, "write-conflict"]]);
      expect(points).toEqual([]);
      expect(await which(dir)).toEqual([false, false, false]);
      expect((await readJson(dir, PROFILE)).statements[1].statement.proposal.text).toBe("Theirs.");
    });
  });

  it("fails the whole write when a target cannot be read before the first rename", async () => {
    await withGoldenCopy(async (dir) => {
      const library = await open(dir);
      const before = await tree(dir);
      const fs: FileSystem = {
        ...realFileSystem,
        open: (async (path: string, flags: unknown) => {
          if (String(path).endsWith("quiet-editorial.json") && typeof flags === "number") {
            throw Object.assign(new Error("EACCES: injected"), { code: "EACCES" });
          }
          return realFileSystem.open(path, flags as never);
        }) as FileSystem["open"],
      };
      const result = await library.write(three, { clock, fs });
      expect(result).toMatchObject({
        status: "failed",
        failure: { code: "io-error", operation: "read", file: FAMILY, errno: "EACCES" },
        written: [],
        notWritten: THREE,
        skipped: SKIPPED,
      });
      expect(await tree(dir)).toEqual(before);
    });
  });
});

describe("a write that stops partway", () => {
  it("reports a conflict at a later file with the files written and not written", async () => {
    await withGoldenCopy(async (dir) => {
      const library = await open(dir);
      const result = await library.write(three, {
        clock,
        at: async (point) => {
          if (point === `wrote:${GLOSSARY}`) {
            await editJson(dir, FAMILY, (family) => {
              family.description.proposal.meaning = "Theirs.";
            });
          }
        },
      });
      expect(result).toMatchObject({
        status: "refused",
        written: [GLOSSARY],
        notWritten: [FAMILY, PROFILE],
        skipped: SKIPPED,
      });
      if (result.status !== "refused") return;
      expect(result.issues.map((i) => [i.file, i.code])).toEqual([[FAMILY, "write-conflict"]]);
      expect(await which(dir)).toEqual([true, false, false]);
      expect(temporaryFiles(await tree(dir))).toEqual([]);
    });
  });

  it("stops with write-conflict when a migration backup appears between two files", async () => {
    await withGoldenCopy(async (dir) => {
      const library = await open(dir);
      const result = await library.write(three, {
        clock,
        at: async (point) => {
          if (point === `wrote:${FAMILY}`) {
            await mkdir(join(dir, ".tastelib", "migration-backup"), { recursive: true });
          }
        },
      });
      expect(result).toMatchObject({
        status: "refused",
        written: [GLOSSARY, FAMILY],
        notWritten: [PROFILE],
      });
      expect(await which(dir)).toEqual([true, true, false]);
    });
  });

  it("reports an I/O error at a later file with the files written and not written", async () => {
    await withGoldenCopy(async (dir) => {
      const library = await open(dir);
      const result = await library.write(three, {
        clock,
        fs: failingRename("quiet-editorial.json", "EIO"),
        platform: "linux",
      });
      expect(result).toMatchObject({
        status: "failed",
        failure: { code: "io-error", operation: "rename", file: FAMILY, errno: "EIO" },
        written: [GLOSSARY],
        notWritten: [FAMILY, PROFILE],
        skipped: SKIPPED,
      });
      expect(await which(dir)).toEqual([true, false, false]);
      expect(temporaryFiles(await tree(dir))).toEqual([]);
    });
  });

  it("counts a file as written when only its folder flush failed", async () => {
    await withGoldenCopy(async (dir) => {
      const library = await open(dir);
      const fs: FileSystem = {
        ...realFileSystem,
        open: (async (path: string, flags: unknown) => {
          // The folder flush opens the folder itself. The library folder flushes (a stand-in
          // handle, so the test runs on Windows too); `families/` fails.
          if (String(path) === dir) return { sync: async () => {}, close: async () => {} };
          if (String(path) === join(dir, "families")) {
            throw Object.assign(new Error("EIO: injected"), { code: "EIO" });
          }
          return realFileSystem.open(path, flags as never);
        }) as FileSystem["open"],
      };
      const result = await library.write(three, {
        clock,
        fs,
        durable: true,
        platform: "linux",
      });
      expect(result).toMatchObject({
        status: "failed",
        failure: { code: "io-error", operation: "sync-folder", file: FAMILY, errno: "EIO" },
        written: [GLOSSARY, FAMILY],
        notWritten: [PROFILE],
      });
      expect(await which(dir)).toEqual([true, true, false]);
    });
  });

  it("removes a folder it created for a later file that was not written", async () => {
    await withGoldenCopy(async (dir) => {
      const library = await open(dir);
      const project = "projects/fresh-start/project.json";
      let renames = 0;
      const result = await library.write(
        (snapshot) => {
          const glossary = copyOf(snapshot, GLOSSARY);
          glossary.terms[0].entry.content.definition = "Changed by a multi-file write.";
          const next = copyOf(snapshot, "projects/internal-dashboard/project.json");
          next.slug = "fresh-start";
          return {
            changes: [
              { path: GLOSSARY, next: glossary },
              { path: project, next },
            ],
            skipped: [],
          };
        },
        {
          clock,
          at: async (point) => {
            if (point === "before-rename" && ++renames === 2) {
              await writeFile(join(dir, "projects", "fresh-start", "project.json"), "{}");
            }
          },
        },
      );
      // The other writer's file keeps the folder; without it, the folder goes.
      expect(result).toMatchObject({
        status: "refused",
        written: [GLOSSARY],
        notWritten: [project],
      });
      expect(await readFile(join(dir, "projects", "fresh-start", "project.json"), "utf8")).toBe(
        "{}",
      );

      const again = await library.write(
        (snapshot) => {
          const glossary = copyOf(snapshot, GLOSSARY);
          glossary.terms[0].entry.content.definition = "Changed again.";
          const next = copyOf(snapshot, "projects/internal-dashboard/project.json");
          next.slug = "other-start";
          return {
            changes: [
              { path: GLOSSARY, next: glossary },
              { path: "projects/other-start/project.json", next },
            ],
            skipped: [],
          };
        },
        { clock, fs: failingRename("project.json", "EIO"), platform: "linux" },
      );
      expect(again).toMatchObject({ status: "failed", written: [GLOSSARY] });
      expect(Object.keys(await tree(dir))).not.toContain("projects/other-start/");
    });
  });

  it("leaves what a crash between two files leaves, cleaning nothing", async () => {
    await withGoldenCopy(async (dir) => {
      const library = await open(dir);
      await expect(
        library.write(three, { clock, at: crashAt(`wrote:${FAMILY}`) }),
      ).rejects.toBeInstanceOf(SimulatedCrash);
      expect(await which(dir)).toEqual([true, true, false]);
      expect(temporaryFiles(await tree(dir))).toEqual([]);
      expect(await issuesOnDisk(dir)).toEqual([]);
    });
  });
});

describe("plans that are bugs", () => {
  const cases: [string, (snapshot: Snapshot) => Plan][] = [
    [
      "a path changed twice",
      (snapshot) => ({
        changes: [
          { path: GLOSSARY, next: copyOf(snapshot, GLOSSARY) },
          { path: GLOSSARY, next: copyOf(snapshot, GLOSSARY) },
        ],
        skipped: [],
      }),
    ],
    [
      "a path of no file type",
      () => ({ changes: [{ path: "notes.json", next: {} }], skipped: [] }),
    ],
    [
      "deleting library.json",
      () => ({ changes: [{ path: "library.json", next: null }], skipped: [] }),
    ],
    [
      "deleting a file that does not exist",
      () => ({ changes: [{ path: `references/${NEW}.json`, next: null }], skipped: [] }),
    ],
    [
      "blocked by a file that does not exist",
      (snapshot) => ({ ...three(snapshot), blockedBy: [`references/${NEW}.json`] }),
    ],
  ];
  for (const [name, build] of cases) {
    it(`throws for ${name}, writing nothing`, async () => {
      await withGoldenCopy(async (dir) => {
        const before = await tree(dir);
        const library = await open(dir);
        const options: LibraryWriteOptions = { clock };
        await expect(library.write(build, options)).rejects.toThrow();
        expect(await tree(dir)).toEqual(before);
      });
    });
  }
});
