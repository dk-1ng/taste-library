import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { crashAtCall, recordPoints, SimulatedCrash } from "../../test/support/crash.js";
import { editJson, GOLDEN_V1, withGoldenCopy } from "../../test/support/golden.js";
import {
  issuesOnDisk,
  type Json,
  open,
  readJson,
  temporaryFiles,
  tree,
} from "../../test/support/library.js";
import { authoredValues, linkEverywhere, linksOnDisk } from "../../test/support/links.js";
import { expectMatchesRebuild } from "../../test/support/rebuild.js";
import {
  planDirectionDeletion,
  planFamilyDeletion,
  planGuardrailDeletion,
  planPinDeletion,
  planReferenceDeletion,
} from "../changes/delete.js";
import type { Plan } from "../changes/plan.js";
import { issueNext } from "../ids/sequence.js";
import type { LinkEvent } from "../validation/cross.js";
import type { Issue } from "../validation/issue.js";
import type { Snapshot } from "../validation/library.js";
import type { Library } from "./open.js";
import { type FileSystem, realFileSystem } from "./replace-file.js";

/**
 * Deletions end to end (format-spec §5, §14; docs/design.md section 15, "Writes"): every link to
 * the deleted thing is removed, the primary change is written first, and a stop at any point
 * leaves at worst `dangling-link` warnings, which running the deletion again clears.
 */

const A = "ref-20261101-a1b2c3";
const D = "ref-20261102-d4e5f6";
const REF_A = `references/${A}.json`;
const NOW = new Date("2026-11-05T10:00:00.000Z");
const clock = () => NOW;

interface Kind {
  name: string;
  /** A piece to link from every kind of holder first, so each holder kind is exercised. */
  link?: string;
  plan: (snapshot: Snapshot) => Plan;
  /** Whether a link points to the deleted thing. */
  gone: (link: LinkEvent) => boolean;
  primary: string;
}

const KINDS: Kind[] = [
  {
    name: "a pin",
    link: `${A}#p1`,
    plan: (snapshot) => planPinDeletion(snapshot, A, "p1"),
    gone: (link) => link.target === `piece ${A}#p1`,
    primary: REF_A,
  },
  {
    name: "a reference",
    link: `${A}#p0`,
    plan: (snapshot) => planReferenceDeletion(snapshot, A),
    gone: (link) => link.target.startsWith(`piece ${A}#`),
    primary: REF_A,
  },
  {
    name: "a family",
    plan: (snapshot) => planFamilyDeletion(snapshot, "quiet-editorial"),
    gone: (link) => link.target === 'family "quiet-editorial"',
    primary: "families/quiet-editorial.json",
  },
  {
    name: "a guardrail",
    plan: (snapshot) => planGuardrailDeletion(snapshot, "gr-3k7m2q"),
    gone: (link) => link.target === "guardrail gr-3k7m2q",
    primary: "guardrails.json",
  },
  {
    name: "a direction",
    plan: (snapshot) => planDirectionDeletion(snapshot, "landing-redesign", "d1"),
    gone: (link) => link.target === 'direction d1 of project "landing-redesign"',
    primary: "projects/landing-redesign/directions.json",
  },
];

/** Opens the copy and adds the kind's links everywhere. */
async function setUp(dir: string, kind: Kind): Promise<Library> {
  const library = await open(dir);
  if (kind.link !== undefined) await linkEverywhere(library, kind.link);
  return library;
}

/** The issues other than `dangling-link` warnings (and the codes in `alsoAllowed`). */
function beyondDangling(issues: Issue[], alsoAllowed: string[] = []): Issue[] {
  return issues.filter(
    (issue) => issue.code !== "dangling-link" && !alsoAllowed.includes(issue.code),
  );
}

/** The files of the plan in the order the deletion writes them, from a run on a scratch copy. */
async function filesOf(kind: Kind): Promise<string[]> {
  return withGoldenCopy(async (dir) => {
    const result = await (await setUp(dir, kind)).write(kind.plan, { clock });
    if (result.status !== "written") throw new Error(JSON.stringify(result));
    return result.written;
  });
}

/** Paths whose bytes differ between two trees, a file that appeared or disappeared included. */
function changedFiles(before: Record<string, string>, after: Record<string, string>): string[] {
  const paths = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...paths].filter((path) => !path.endsWith("/") && before[path] !== after[path]).sort();
}

/** Runs the deletion again on `dir` and checks that it finishes: no issue and no link left. */
async function expectFinishesAgain(dir: string, kind: Kind, label: string): Promise<void> {
  const again = await (await open(dir)).write(kind.plan, { clock });
  expect(again.status, label).toBe("written");
  expect(await issuesOnDisk(dir), label).toEqual([]);
  expect((await linksOnDisk(dir)).filter(kind.gone), label).toEqual([]);
  expect(temporaryFiles(await tree(dir)), label).toEqual([]);
}

/** `after` holds only values found in `before`, each at most as often. */
function expectSubset(after: string[], before: string[]): void {
  const left = [...before];
  for (const value of after) {
    const index = left.indexOf(value);
    expect(index, value).toBeGreaterThanOrEqual(0);
    left.splice(index, 1);
  }
}

describe("deleting each kind of thing", () => {
  for (const kind of KINDS) {
    it(`removes every link to ${kind.name}, touching only the files that held one`, async () => {
      await withGoldenCopy(async (dir) => {
        const library = await setUp(dir, kind);
        expect((await linksOnDisk(dir)).filter(kind.gone).length).toBeGreaterThan(0);
        const before = await tree(dir);
        const authored = await authoredValues(dir);

        const result = await library.write(kind.plan, { clock });
        expect(result).toMatchObject({ status: "written", skipped: [], notices: [] });
        if (result.status !== "written") return;
        expect(result.written[0]).toBe(kind.primary);
        expect(result.written.length).toBeGreaterThan(1);

        const after = await tree(dir);
        expect(changedFiles(before, after)).toEqual([...result.written].sort());
        // Each holder moved the `updatedAt` of the file or the entry that held the link. (A
        // primary change that only removes an entry, from guardrails.json or directions.json,
        // leaves no entry or file `updatedAt` to move.)
        for (const path of result.written.slice(1)) {
          expect(after[path], path).toContain(NOW.toISOString());
        }
        expect((await linksOnDisk(dir)).filter(kind.gone)).toEqual([]);
        // No Authored value was edited: the ones left are among those before.
        expectSubset(await authoredValues(dir), authored);
        expect(await issuesOnDisk(dir)).toEqual([]);
      });
    });
  }

  it("moves the updatedAt of the entries that held a link and of no other", async () => {
    await withGoldenCopy(async (dir) => {
      const library = await setUp(dir, KINDS[0] as Kind);
      const before = await readJson(dir, "glossary.json");
      await library.write((snapshot) => planPinDeletion(snapshot, A, "p1"), { clock });
      const after = await readJson(dir, "glossary.json");
      expect(after.terms.map((term: Json) => term.updatedAt)).toEqual([
        before.terms[0].updatedAt,
        NOW.toISOString(),
        before.terms[2].updatedAt,
        before.terms[3].updatedAt,
      ]);
    });
  });
});

const INSIDE_A_REPLACE = new Set(["temp-written", "before-rename"]);

describe("a deletion that stops at any point", () => {
  for (const kind of KINDS) {
    it(`leaves only dangling-link warnings for ${kind.name}, and finishes when run again`, async () => {
      const points = await withGoldenCopy(async (dir) => {
        const recorder = recordPoints();
        await (await setUp(dir, kind)).write(kind.plan, { clock, at: recorder.at });
        return recorder.points;
      });
      expect(points[0]).toBe("checked");
      for (let call = 1; call <= points.length; call++) {
        const point = points[call - 1] as string;
        await withGoldenCopy(async (dir) => {
          const library = await setUp(dir, kind);
          await expect(
            library.write(kind.plan, { clock, at: crashAtCall(call).at }),
          ).rejects.toBeInstanceOf(SimulatedCrash);
          const allowed = INSIDE_A_REPLACE.has(point) ? ["leftover-temp-file"] : [];
          expect(beyondDangling(await issuesOnDisk(dir), allowed), `${call}: ${point}`).toEqual([]);

          const again = await (await open(dir)).write(kind.plan, { clock });
          expect(["written", "unchanged"], `${call}: ${point}`).toContain(again.status);
          const left = (await issuesOnDisk(dir)).filter((i) => i.code !== "leftover-temp-file");
          expect(left, `${call}: ${point}`).toEqual([]);
          expect((await linksOnDisk(dir)).filter(kind.gone)).toEqual([]);
        });
      }
    }, 60_000);
  }
});

describe("a deletion stopped by a conflict or an I/O error", () => {
  for (const kind of KINDS) {
    it(`reports the files written and not written when ${kind.name} stops at each file`, async () => {
      const files = await filesOf(kind);
      for (const [index, path] of files.entries()) {
        // A migration backup appears just before this file's rename or removal.
        await withGoldenCopy(async (dir) => {
          const library = await setUp(dir, kind);
          let renames = 0;
          const result = await library.write(kind.plan, {
            clock,
            at: async (point) => {
              if (point === "before-rename" || point === "before-unlink") {
                if (renames++ === index) {
                  await mkdir(join(dir, ".tastelib", "migration-backup"), { recursive: true });
                }
              }
            },
          });
          expect(result, path).toMatchObject({
            status: "refused",
            written: files.slice(0, index),
            notWritten: files.slice(index),
          });
          expect(beyondDangling(await issuesOnDisk(dir)), path).toEqual([]);
          expect(temporaryFiles(await tree(dir))).toEqual([]);

          // Once the migration is over, running the deletion again finishes it.
          await rm(join(dir, ".tastelib", "migration-backup"), { recursive: true });
          await expectFinishesAgain(dir, kind, path);
        });

        // The rename or removal of this file fails.
        await withGoldenCopy(async (dir) => {
          const library = await setUp(dir, kind);
          const target = join(dir, ...path.split("/"));
          const fail = () => Object.assign(new Error("EIO: injected"), { code: "EIO" });
          const fs: FileSystem = {
            ...realFileSystem,
            rename: async (from, to) => {
              if (String(to) === target) throw fail();
              return realFileSystem.rename(from, to);
            },
            unlink: async (file) => {
              if (String(file) === target) throw fail();
              return realFileSystem.unlink(file);
            },
          };
          const result = await library.write(kind.plan, { clock, fs, platform: "linux" });
          expect(result, path).toMatchObject({
            status: "failed",
            failure: { code: "io-error", file: path, errno: "EIO" },
            written: files.slice(0, index),
            notWritten: files.slice(index),
          });
          expect(beyondDangling(await issuesOnDisk(dir)), path).toEqual([]);
          expect(temporaryFiles(await tree(dir))).toEqual([]);

          // Without the fault, running the deletion again finishes it.
          await expectFinishesAgain(dir, kind, path);
        });
      }
    }, 60_000);
  }

  it("writes nothing when a file changes before the first rename", async () => {
    await withGoldenCopy(async (dir) => {
      const library = await setUp(dir, KINDS[1] as Kind);
      let expected: Record<string, string> = {};
      const result = await library.write(
        async (snapshot) => {
          await editJson(dir, "taste-profile.json", (profile) => {
            profile.statements[0].statement.content.text = "Changed by someone else.";
          });
          expected = await tree(dir);
          return planReferenceDeletion(snapshot, A);
        },
        { clock },
      );
      expect(result).toMatchObject({ status: "refused", written: [] });
      if (result.status !== "refused") return;
      expect(result.notWritten).toContain(REF_A);
      expect(result.issues.map((i) => [i.file, i.code])).toEqual([
        ["taste-profile.json", "write-conflict"],
      ]);
      expect(await tree(dir)).toEqual(expected);
    });
  });
});

describe("files with errors", () => {
  it("skips a holder with errors, still deletes, and the link shows once it is repaired", async () => {
    await withGoldenCopy(async (dir) => {
      await writeFile(join(dir, "glossary.json"), "{ not json");
      const library = await open(dir);
      const result = await library.write((s) => planReferenceDeletion(s, A), { clock });
      expect(result).toMatchObject({
        status: "written",
        skipped: [{ path: "glossary.json", reason: "invalid" }],
      });
      expect(await readFile(join(dir, "glossary.json"), "utf8")).toBe("{ not json");

      await writeFile(
        join(dir, "glossary.json"),
        await readFile(join(GOLDEN_V1, "glossary.json"), "utf8"),
      );
      const issues = await issuesOnDisk(dir);
      expect(issues.map((i) => [i.code, i.file])).toEqual([["dangling-link", "glossary.json"]]);
      await expectMatchesRebuild(library, dir);
    });
  });

  const BROKEN_OWN_FILE: { name: string; path: string; plan: (snapshot: Snapshot) => Plan }[] = [
    {
      name: "a reference whose file",
      path: REF_A,
      plan: (snapshot) => planReferenceDeletion(snapshot, A),
    },
    {
      name: "a family whose file",
      path: "families/quiet-editorial.json",
      plan: (snapshot) => planFamilyDeletion(snapshot, "quiet-editorial"),
    },
    {
      name: "a pin whose reference",
      path: REF_A,
      plan: (snapshot) => planPinDeletion(snapshot, A, "p1"),
    },
  ];

  for (const broken of BROKEN_OWN_FILE) {
    it(`refuses to delete ${broken.name} has errors, removing no link`, async () => {
      await withGoldenCopy(async (dir) => {
        await writeFile(join(dir, ...broken.path.split("/")), "{ broken");
        const library = await open(dir);
        const snapshot = await library.snapshot();
        if (!snapshot.ok) throw new Error(snapshot.message);
        const own = snapshot.snapshot.files.get(broken.path)?.issues ?? [];
        expect(own.map((issue) => issue.code)).toEqual(["invalid-json"]);
        // Without the refusal, the deletion would remove links from other files.
        expect(broken.plan(snapshot.snapshot).changes.length).toBeGreaterThan(0);
        const before = await tree(dir);

        const result = await library.write(broken.plan, { clock });
        expect(result).toMatchObject({ status: "refused", written: [], notWritten: [] });
        if (result.status !== "refused") return;
        expect(result.issues).toEqual(own);
        expect(await tree(dir)).toEqual(before);
      });
    });
  }

  it("refuses to delete an entry of a file that has errors, writing nothing", async () => {
    await withGoldenCopy(async (dir) => {
      await editJson(dir, "guardrails.json", (guardrails) => {
        guardrails.guardrails[0].id = "not an id";
      });
      const before = await tree(dir);
      const library = await open(dir);
      const result = await library.write((s) => planGuardrailDeletion(s, "gr-3k7m2q"), { clock });
      expect(result).toMatchObject({ status: "refused", written: [], notWritten: [] });
      if (result.status !== "refused") return;
      expect(result.issues.length).toBeGreaterThan(0);
      expect(result.issues.every((i) => i.file === "guardrails.json")).toBe(true);
      expect(await tree(dir)).toEqual(before);
    });
  });
});

describe("sequential numbers", () => {
  it("never issues a deleted pin's number again", async () => {
    await withGoldenCopy(async (dir) => {
      const library = await open(dir);
      expect((await library.write((s) => planPinDeletion(s, A, "p2"), { clock })).status).toBe(
        "written",
      );
      const result = await library.write(
        (snapshot) => {
          const reference = structuredClone(snapshot.files.get(REF_A)?.value) as Json;
          const { id, lastIssued } = issueNext("p", reference.lastIssued.pin);
          reference.pins.push({
            id,
            mediaId: "m1",
            frameMs: null,
            region: { x: 0.5, y: 0.5, w: 0.25, h: 0.25 },
            polarity: "positive",
            note: "A new pin.",
            createdAt: NOW.toISOString(),
          });
          reference.lastIssued.pin = lastIssued;
          return { changes: [{ path: REF_A, next: reference }], skipped: [] };
        },
        { clock },
      );
      expect(result.status).toBe("written");
      const reference = await readJson(dir, REF_A);
      expect(reference.pins.map((pin: Json) => pin.id)).toEqual(["p1", "p3"]);
      expect(reference.lastIssued.pin).toBe(3);
      expect(await issuesOnDisk(dir)).toEqual([]);
      await expectMatchesRebuild(library, dir);
    });
  });

  it("never issues a deleted direction's number again", async () => {
    await withGoldenCopy(async (dir) => {
      const path = "projects/landing-redesign/directions.json";
      const library = await open(dir);
      const deleted = await library.write(
        (s) => planDirectionDeletion(s, "landing-redesign", "d2"),
        { clock },
      );
      expect(deleted.status).toBe("written");
      await library.write(
        (snapshot) => {
          const directions = structuredClone(snapshot.files.get(path)?.value) as Json;
          const { id, lastIssued } = issueNext("d", directions.lastIssued.direction);
          directions.directions.push({
            id,
            createdAt: NOW.toISOString(),
            updatedAt: NOW.toISOString(),
            family: null,
            pieces: [],
            guardrails: [],
            plan: {
              origin: "user",
              content: { title: "Another way", why: "To compare." },
              writtenAt: NOW.toISOString(),
            },
          });
          directions.lastIssued.direction = lastIssued;
          return { changes: [{ path, next: directions }], skipped: [] };
        },
        { clock },
      );
      const directions = await readJson(dir, path);
      expect(directions.directions.map((d: Json) => d.id)).toEqual(["d1", "d3"]);
      expect(directions.lastIssued.direction).toBe(3);
    });
  });
});

describe("Windows", () => {
  it("retries a deletion that a held file makes fail once", async () => {
    await withGoldenCopy(async (dir) => {
      const library = await open(dir);
      const target = join(dir, "references", `${D}.json`);
      let attempts = 0;
      const fs: FileSystem = {
        ...realFileSystem,
        unlink: async (file) => {
          if (String(file) === target && attempts++ === 0) {
            throw Object.assign(new Error("EPERM: injected"), { code: "EPERM" });
          }
          return realFileSystem.unlink(file);
        },
      };
      const result = await library.write((s) => planReferenceDeletion(s, D), {
        clock,
        fs,
        platform: "win32",
        sleep: async () => undefined,
      });
      expect(result).toMatchObject({ status: "written", written: [`references/${D}.json`] });
      expect(attempts).toBe(2);
      expect(await issuesOnDisk(dir)).toEqual([]);
    });
  });
});
