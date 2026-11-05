import { mkdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createSeededRandom, withTempDir } from "@tastelib/testkit";
import { describe, expect, it } from "vitest";
import { generateLibrary } from "../../test/support/generate.js";
import type { Json } from "../../test/support/library.js";
import { expectMatchesRebuild } from "../../test/support/rebuild.js";
import { planPinDeletion, planReferenceDeletion } from "../changes/delete.js";
import type { Plan } from "../changes/plan.js";
import type { Snapshot } from "../validation/library.js";
import { type Library, type OpenOptions, openLibrary } from "./open.js";

const HOUR = 3_600_000;
const clock = () => new Date("2026-11-05T10:00:00.000Z");

async function openOrFail(dir: string, options: OpenOptions = {}): Promise<Library> {
  const opened = await openLibrary(dir, options);
  if (!opened.ok) throw new Error(opened.message);
  return opened.library;
}

async function snap(library: Library): Promise<Snapshot> {
  const result = await library.snapshot();
  if (!result.ok) throw new Error(result.message);
  return result.snapshot;
}

describe("the generated library", () => {
  it("opens with no error and no warning, and every derived state occurs", async () => {
    await withTempDir(async (dir) => {
      const generated = await generateLibrary(dir, {
        references: 50,
        families: 5,
        membersPerFamily: 20,
        terms: 30,
        seed: 1,
      });
      const snapshot = await snap(await openOrFail(dir));
      expect(snapshot.issues.filter((issue) => issue.severity !== "info")).toEqual([]);
      expect(snapshot.index.references.size).toBe(50);
      expect([...snapshot.index.references.keys()]).toEqual(generated.references);
      const states = new Set([...snapshot.index.references.values()].map((r) => r.state));
      expect([...states].sort()).toEqual(["inbox", "processed", "reviewed"]);
      expect(snapshot.index.families.size).toBeGreaterThan(0);
      expect([...snapshot.files.keys()]).toEqual(generated.files);
    });
  });

  it("is the same for the same seed", async () => {
    await withTempDir(async (dir) => {
      const options = { references: 5, families: 2, membersPerFamily: 3, terms: 4, seed: 9 };
      await mkdir(join(dir, "a"));
      await mkdir(join(dir, "b"));
      const a = await generateLibrary(join(dir, "a"), options);
      const b = await generateLibrary(join(dir, "b"), options);
      expect(a).toEqual(b);
      for (const file of a.files) {
        const path = file.split("/");
        expect(await readFile(join(dir, "b", ...path), "utf8")).toBe(
          await readFile(join(dir, "a", ...path), "utf8"),
        );
      }
    });
  });
});

/** One random step that changes the library, from outside or through a handle. */
type Step = (context: StepContext) => Promise<void>;

interface StepContext {
  dir: string;
  pick<T>(items: readonly T[]): T;
  chance(p: number): boolean;
  /** Reference ids present now. */
  references: string[];
  library: Library;
  other: Library;
  /** Bytes of files broken by a step, to repair them later. */
  broken: Map<string, Buffer>;
}

const at = (dir: string, relative: string): string => join(dir, ...relative.split("/"));

async function editOnDisk(dir: string, relative: string, change: (value: Json) => void) {
  const value = JSON.parse(await readFile(at(dir, relative), "utf8"));
  change(value);
  await writeFile(at(dir, relative), `${JSON.stringify(value, null, 2)}\n`);
}

const STEPS: Record<string, Step> = {
  async "outside edit of a reference"({ dir, pick, references, chance }) {
    const id = pick(references);
    await editOnDisk(dir, `references/${id}.json`, (value) => {
      const pieces = Object.keys(value.interpretations);
      const roll = chance(0.5);
      if (roll && pieces.length > 0) {
        const interpretation = value.interpretations[pick(pieces)];
        if (interpretation.origin === "agent") {
          interpretation.status = interpretation.status === "to-review" ? "accepted" : "to-review";
          interpretation.correction = null;
          interpretation.reviewedAt =
            interpretation.status === "to-review" ? null : "2026-11-03T12:00:00.000Z";
        } else delete value.interpretations[pick(pieces)];
      } else if (chance(0.5)) {
        const next = value.lastIssued.pin + 1;
        value.pins.push({
          id: `p${next}`,
          mediaId: "m1",
          frameMs: null,
          region: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
          polarity: "positive",
          note: "Added from outside.",
          createdAt: value.createdAt,
        });
        value.lastIssued.pin = next;
      } else {
        value.note = `${value.note} Edited from outside.`; // proposals over it become stale
      }
    });
  },
  async "outside new reference"({ dir, pick, references }) {
    const source = pick(references);
    const id = `ref-20261231-${String(references.length).padStart(6, "0")}`;
    if (references.includes(id)) return;
    const text = await readFile(at(dir, `references/${source}.json`), "utf8");
    await writeFile(at(dir, `references/${id}.json`), text.replaceAll(source, id));
    references.push(id);
  },
  async "outside deletion of a reference"({ dir, pick, references, broken }) {
    if (references.length < 5) return;
    const id = pick(references);
    await rm(at(dir, `references/${id}.json`));
    broken.delete(`references/${id}.json`);
    references.splice(references.indexOf(id), 1);
  },
  async "break a file or repair it"({ dir, pick, chance, references, broken }) {
    const repairable = [...broken.keys()];
    if (repairable.length > 0 && chance(0.6)) {
      const path = pick(repairable);
      await writeFile(at(dir, path), broken.get(path) as Buffer);
      broken.delete(path);
      return;
    }
    const path = pick([
      `references/${pick(references)}.json`,
      "glossary.json",
      "families/family-1.json",
      "guardrails.json",
    ]);
    try {
      broken.set(path, await readFile(at(dir, path)));
    } catch {
      return; // already gone
    }
    await writeFile(at(dir, path), "{ broken");
  },
  async "outside family member change"({ dir, pick, broken }) {
    const path = pick(["families/family-1.json", "families/family-2.json"]);
    if (broken.has(path)) return;
    try {
      await editOnDisk(dir, path, (value) => {
        value.members.splice(0, 1);
      });
    } catch {
      return; // deleted by a planner
    }
  },
  async "same-size rewrite with the mtime put back"({ dir, pick, references, broken }) {
    const path = `references/${pick(references)}.json`;
    if (broken.has(path)) return;
    const file = at(dir, path);
    const before = await stat(file);
    const text = await readFile(file, "utf8");
    const index = text.indexOf('"note": "') + 9;
    const swapped = text[index] === "X" ? "Y" : "X";
    await writeFile(file, `${text.slice(0, index)}${swapped}${text.slice(index + 1)}`);
    await utimes(file, before.atime, before.mtime);
  },
  async ".tastelib/ junk added or removed"({ dir, chance }) {
    if (chance(0.5)) {
      await mkdir(join(dir, ".tastelib", "cache"), { recursive: true });
      await writeFile(join(dir, ".tastelib", "cache", "index.json"), "junk");
    } else await rm(join(dir, ".tastelib"), { recursive: true, force: true });
  },
  async "unexpected file added or removed"({ dir, chance }) {
    const path = join(dir, "references", "notes.txt");
    if (chance(0.5)) await writeFile(path, "not part of the format");
    else await rm(path, { force: true });
  },
  async "a write through the handle"({ library, pick, references, chance }) {
    const id = pick(references);
    const result = await library.write(
      (snapshot): Plan => {
        if (chance(0.3)) return planReferenceDeletion(snapshot, id);
        const file = snapshot.files.get(`references/${id}.json`);
        if (file?.status === "valid" && chance(0.5)) {
          const pins = (file.value as Json).pins as Json[];
          if (pins.length > 0) return planPinDeletion(snapshot, id, pick(pins).id);
        }
        if (file?.status !== "valid") return { changes: [], skipped: [] };
        const value = structuredClone(file.value) as Json;
        value.note = `${value.note} Edited through the handle.`;
        return { changes: [{ path: `references/${id}.json`, next: value }], skipped: [] };
      },
      { clock },
    );
    if (result.status === "written" && result.written.includes(`references/${id}.json`)) {
      const after = await snap(library);
      if (!after.files.has(`references/${id}.json`)) references.splice(references.indexOf(id), 1);
    }
  },
  async "a write through a second handle"({ other, pick, references }) {
    const id = pick(references);
    await other.write(
      (snapshot) => {
        const file = snapshot.files.get(`references/${id}.json`);
        if (file?.status !== "valid") return { changes: [], skipped: [] };
        const value = structuredClone(file.value) as Json;
        value.note = `${value.note} Edited through another handle.`;
        return { changes: [{ path: `references/${id}.json`, next: value }], skipped: [] };
      },
      { clock },
    );
  },
};

describe("rebuild equals updates", () => {
  const clocks: [string, OpenOptions][] = [
    ["the system clock", {}],
    ["a clock one hour ahead (every file settled)", { statClock: () => Date.now() + HOUR }],
  ];
  for (const [clockName, options] of clocks) {
    for (const seed of [11, 22, 33]) {
      it(`after every one of 40 random steps, with ${clockName}, seed ${seed}`, async () => {
        await withTempDir(async (dir) => {
          const generated = await generateLibrary(dir, {
            references: 30,
            families: 3,
            membersPerFamily: 10,
            terms: 10,
            seed,
          });
          const random = createSeededRandom(seed);
          const pick = <T>(items: readonly T[]): T => items[random.int(items.length)] as T;
          const context: StepContext = {
            dir,
            pick,
            chance: (p) => random.next() < p,
            references: [...generated.references],
            library: await openOrFail(dir, options),
            other: await openOrFail(dir),
            broken: new Map(),
          };
          const names = Object.keys(STEPS);
          for (let step = 0; step < 40; step++) {
            const name = pick(names);
            await (STEPS[name] as Step)(context);
            try {
              await expectMatchesRebuild(context.library, dir);
            } catch (error) {
              throw new Error(`step ${step} (${name}) differs from a rebuild`, { cause: error });
            }
          }
        });
      }, 60_000);
    }
  }
});
