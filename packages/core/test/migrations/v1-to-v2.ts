import type { LibraryValues } from "../../src/migrations/steps.js";
import { versionOf } from "../../src/validation/file.js";

/**
 * The test-only step from format version 1 to the test-only version 2 (docs/design.md section 15,
 * "Core test approach"). Test-only: it lives outside `src/`, so it can never reach `dist/`. It is
 * pure and deterministic like a real step (format-spec §15.4), and does each thing a real step may
 * do:
 *
 * - it changes files: `formatVersion` becomes 2 in every file at version 1;
 * - it adds files and removes one: `glossary.json` is split into one file per term,
 *   `glossary/<term-id>.json`, and removed;
 * - it moves data between files: `library.json`'s `language` is copied into each `project.json`.
 *
 * It touches only files at version 1 and passes the others through unchanged (the same object), so
 * a term file already at version 2 is kept even when `glossary.json` still has a term with its id.
 * The values it returns share nothing with its input, and its files are sorted by path.
 */

// biome-ignore lint/suspicious/noExplicitAny: a step reads and builds arbitrary JSON it was given valid
type Json = any;

const PROJECT = /^projects\/[^/]+\/project\.json$/;

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function v1ToV2(library: LibraryValues): LibraryValues {
  const language = (library.get("library.json") as Json)?.language;
  if (typeof language !== "string") {
    throw new Error("The step was given a library without a valid library.json.");
  }
  const out = new Map<string, unknown>();
  const split: [string, unknown][] = [];
  for (const [path, value] of library) {
    if (versionOf(value) !== 1) {
      out.set(path, value);
      continue;
    }
    const copy = structuredClone(value) as Json;
    if (path === "glossary.json") {
      for (const term of copy.terms as Json[]) {
        split.push([`glossary/${term.id}.json`, { formatVersion: 2, ...term }]);
      }
    } else if (PROJECT.test(path)) {
      out.set(path, { ...copy, formatVersion: 2, language });
    } else {
      // `formatVersion` keeps its place: a spread keeps the position of a key it overwrites.
      out.set(path, { ...copy, formatVersion: 2 });
    }
  }
  for (const [path, term] of split) {
    if (!out.has(path)) out.set(path, term);
  }
  return new Map([...out].sort(([a], [b]) => compareText(a, b)));
}
