import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withTempDir } from "@tastelib/testkit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Generated, generateLibrary } from "../../test/support/generate.js";
import type { Json } from "../../test/support/library.js";
import type { Snapshot } from "../validation/library.js";
import { type Library, openLibrary } from "./open.js";

/**
 * The performance budget of the index (docs/design.md section 4, "Index", "Performance budget";
 * section 15, "Core test approach"): a library generated with a fixed seed (not timed), opened
 * once to warm up, then each budget line timed once.
 */

const SETUP_MS = 600_000;
const LINE_MS = 60_000;

let root = "";
let generated: Generated;
let library: Library;
let finish: () => void = () => undefined;
let removed: Promise<unknown> = Promise.resolve();

async function snap(): Promise<Snapshot> {
  const result = await library.snapshot();
  if (!result.ok) throw new Error(result.message);
  return result.snapshot;
}

/** Runs `fn` once and returns how long it took, in milliseconds. */
async function timed<T>(fn: () => Promise<T>): Promise<{ ms: number; value: T }> {
  const start = performance.now();
  const value = await fn();
  return { ms: performance.now() - start, value };
}

beforeAll(async () => {
  const ready = new Promise<string>((resolve) => {
    removed = withTempDir(async (dir) => {
      resolve(dir);
      await new Promise<void>((done) => {
        finish = done;
      });
    });
  });
  root = await ready;
  generated = await generateLibrary(root, {
    references: 5000,
    families: 50,
    membersPerFamily: 100,
    terms: 300,
    seed: 20261105,
  });
  // Warm-up, not timed.
  const warm = await openLibrary(root);
  if (!warm.ok) throw new Error(warm.message);
}, SETUP_MS);

afterAll(async () => {
  finish();
  await removed;
}, SETUP_MS);

describe("the performance budget, on 5000 generated references", () => {
  it(
    "opens the library in under 5 seconds",
    async () => {
      const { ms, value } = await timed(() => openLibrary(root));
      if (!value.ok) throw new Error(value.message);
      library = value.library;
      expect(ms, `openLibrary took ${Math.round(ms)} ms`).toBeLessThan(5000);
    },
    LINE_MS,
  );

  it(
    "refreshes in under 0.5 seconds when nothing changed, returning the same snapshot",
    async () => {
      const before = await snap();
      const { ms, value } = await timed(() => snap());
      expect(ms, `the refresh took ${Math.round(ms)} ms`).toBeLessThan(500);
      expect(value).toBe(before);
      expect(value.index.references.size).toBe(5000);
    },
    LINE_MS,
  );

  it(
    "refreshes in under 0.5 seconds after one reference changed, with the index updated",
    async () => {
      const before = await snap();
      const inbox = [...before.index.references.values()].find((r) => r.state === "inbox");
      if (inbox === undefined) throw new Error("no reference in the inbox");
      const path = join(root, "references", `${inbox.id}.json`);
      const value: Json = JSON.parse(await readFile(path, "utf8"));
      // An agent proposes an interpretation of p0 from outside (another process).
      value.interpretations.p0 = {
        origin: "agent",
        proposedBy: "claude-code",
        proposedAt: "2026-11-05T09:00:00.000Z",
        inputSha256: "0".repeat(64),
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
      };
      await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
      const { ms, value: after } = await timed(() => snap());
      expect(ms, `the refresh took ${Math.round(ms)} ms`).toBeLessThan(500);
      expect(after.index.references.get(inbox.id)?.state).toBe("processed");
    },
    LINE_MS,
  );

  it(
    "writes one reference in under 1 second, gate and fsync included",
    async () => {
      const id = generated.references[1] as string;
      const { ms, value } = await timed(() =>
        library.write((snapshot) => {
          const file = snapshot.files.get(`references/${id}.json`);
          const next = structuredClone(file?.value) as Json;
          next.note = `${next.note} Edited.`;
          return { changes: [{ path: `references/${id}.json`, next }], skipped: [] };
        }),
      );
      expect(value.status).toBe("written");
      expect(ms, `the write took ${Math.round(ms)} ms`).toBeLessThan(1000);
    },
    LINE_MS,
  );
});
