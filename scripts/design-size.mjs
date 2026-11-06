// Fails when docs/design.md grows past its word limit (docs/design.md, introduction, "Size").
// Plain Node, no dependencies, so it runs the same on Linux, Windows and macOS.
// Raising the limit is a maintainer decision, recorded in docs/design.md §18.

import { readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

export const LIMIT = 12000;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DESIGN = join(ROOT, "docs", "design.md");

/** Words as `wc -w` counts them: runs of characters between whitespace. */
export function countWords(text) {
  return text.split(/\s+/u).filter(Boolean).length;
}

/**
 * Checks one file (docs/design.md by default) and returns the exit code: 0 within the
 * limit, 1 above it, 2 when the file cannot be read.
 */
export function main(args = [], io = { out: console.log, err: console.error }) {
  const file = args[0] ?? DESIGN;
  const name = relative(ROOT, file).split("\\").join("/") || file;
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    io.err(`${name}: cannot be read (${error.code ?? error.message})`);
    return 2;
  }
  const words = countWords(text);
  if (words > LIMIT) {
    io.err(
      `${name}: ${words} words, above the limit of ${LIMIT}. Keep only promises and ` +
        "contracts (docs/design.md, introduction); raising the limit is a maintainer " +
        "decision, recorded in §18.",
    );
    return 1;
  }
  io.out(`${name}: ${words} words (limit ${LIMIT})`);
  return 0;
}

if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2));
}
