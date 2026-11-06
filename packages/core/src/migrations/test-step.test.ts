import { describe, expect, it } from "vitest";
import { GOLDEN_V1, readValues } from "../../test/support/golden.js";
import { v1ToV2 } from "../../test/migrations/v1-to-v2.js";

/**
 * The test-only step v1 to v2 (docs/design.md section 15, "Core test approach"): it does each
 * thing a real step may do, so the runner is tested with a real step before the first real one
 * exists. These tests pin what it does; the chain test checks that its output validates.
 */

// biome-ignore lint/suspicious/noExplicitAny: tests read arbitrary JSON
type Json = any;

/** Freezes `value` and everything inside it, so a step that mutates its input throws. */
function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value)) deepFreeze(inner);
  }
  return value;
}

async function golden(): Promise<Map<string, Json>> {
  return readValues(GOLDEN_V1);
}

describe("the test-only step v1 to v2", () => {
  it("sets formatVersion 2 in every file", async () => {
    const output = v1ToV2(await golden());
    expect(output.size).toBeGreaterThan(0);
    for (const [path, value] of output) {
      expect((value as Json).formatVersion, path).toBe(2);
      // `formatVersion` stays the first key, as in every file of the format.
      expect(Object.keys(value as Json)[0], path).toBe("formatVersion");
    }
  });

  it("splits glossary.json into one file per term and removes it", async () => {
    const input = await golden();
    const output = v1ToV2(input);
    expect(output.has("glossary.json")).toBe(false);
    const terms = (input.get("glossary.json") as Json).terms as Json[];
    expect(terms.length).toBeGreaterThan(1);
    const split = [...output.keys()].filter((path) => path.startsWith("glossary/"));
    expect(split).toEqual(terms.map((term) => `glossary/${term.id}.json`).sort());
    for (const term of terms) {
      expect(output.get(`glossary/${term.id}.json`)).toEqual({ formatVersion: 2, ...term });
    }
  });

  it("copies library.json's language into each project.json", async () => {
    const input = await golden();
    const output = v1ToV2(input);
    const language = (input.get("library.json") as Json).language;
    const projects = [...input.keys()].filter((path) => path.endsWith("/project.json"));
    expect(projects).toHaveLength(2);
    for (const path of projects) {
      expect(output.get(path), path).toEqual({
        ...(input.get(path) as Json),
        formatVersion: 2,
        language,
      });
    }
    // library.json keeps its language: the data is copied, not moved out of it.
    expect((output.get("library.json") as Json).language).toBe(language);
  });

  it("changes nothing else in the other files", async () => {
    const input = await golden();
    const output = v1ToV2(input);
    for (const [path, value] of input) {
      if (path === "glossary.json" || path.endsWith("/project.json")) continue;
      expect(output.get(path), path).toEqual({ ...(value as Json), formatVersion: 2 });
    }
  });

  it("returns the files sorted by path", async () => {
    const paths = [...v1ToV2(await golden()).keys()];
    expect(paths).toEqual([...paths].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
  });

  it("passes files already at version 2 through unchanged", async () => {
    const input = await golden();
    const family = { ...(input.get("families/quiet-editorial.json") as Json), formatVersion: 2 };
    const project = {
      ...(input.get("projects/internal-dashboard/project.json") as Json),
      formatVersion: 2,
      language: "pt-BR",
    };
    const glossary = (input.get("glossary.json") as Json).terms as Json[];
    const first = glossary[0];
    const term = { formatVersion: 2, ...first, pieces: [] };
    const extra = { formatVersion: 2, ...first, id: "term-x2y4z6" };
    input.set("families/quiet-editorial.json", family);
    input.set("projects/internal-dashboard/project.json", project);
    // A term file at version 2 with the id of a v1 term: the v2 file is kept, not overwritten.
    input.set(`glossary/${first.id}.json`, term);
    input.set("glossary/term-x2y4z6.json", extra);
    const library = { ...(input.get("library.json") as Json), formatVersion: 2 };
    input.set("library.json", library);

    const output = v1ToV2(input);
    expect(output.get("families/quiet-editorial.json")).toBe(family);
    expect(output.get("projects/internal-dashboard/project.json")).toBe(project);
    expect(output.get(`glossary/${first.id}.json`)).toBe(term);
    expect(output.get("glossary/term-x2y4z6.json")).toBe(extra);
    expect(output.get("library.json")).toBe(library);
    // A v1 project still takes the language of library.json, at whatever version it is.
    expect((output.get("projects/landing-redesign/project.json") as Json).language).toBe("en");
    expect(output.has("glossary.json")).toBe(false);
  });

  it("never changes its input", async () => {
    const input = await golden();
    const before = structuredClone(input);
    // Frozen, so a step that writes into its input throws here instead of passing silently.
    for (const value of input.values()) deepFreeze(value);
    const frozen = new Map(input);
    v1ToV2(frozen);
    expect(frozen).toEqual(before);
    expect([...frozen.keys()]).toEqual([...before.keys()]);
  });

  it("returns values that share nothing with its input", async () => {
    const input = await golden();
    const output = v1ToV2(input);
    const terms = (output.get("glossary/term-2b4d6f.json") as Json).pieces as string[];
    terms.push("ref-20261102-d4e5f6#p0");
    const project = output.get("projects/landing-redesign/project.json") as Json;
    project.discarded.pop();
    expect((input.get("glossary.json") as Json).terms[0].pieces).toEqual([
      "ref-20261101-a1b2c3#p0",
    ]);
    expect((input.get("projects/landing-redesign/project.json") as Json).discarded).toHaveLength(2);
  });

  it("gives the same output on two runs", async () => {
    const first = v1ToV2(await golden());
    const second = v1ToV2(await golden());
    expect(JSON.stringify([...second])).toBe(JSON.stringify([...first]));
  });
});
