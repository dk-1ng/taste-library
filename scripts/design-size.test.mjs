// Tests for the word limit of docs/design.md (synthetic files in a non-ASCII temporary folder).

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { countWords, LIMIT, main } from "./design-size.mjs";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "design-size.mjs");

function withFile(text, run) {
  const folder = mkdtempSync(join(tmpdir(), "design-size-Usuário-"));
  try {
    const file = join(folder, "design.md");
    writeFileSync(file, text);
    return run(file);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

const words = (n) => `${"word ".repeat(n)}\n`;
const quiet = () => {
  const lines = { out: [], err: [] };
  return { lines, io: { out: (l) => lines.out.push(l), err: (l) => lines.err.push(l) } };
};

test("counts words as wc -w does", () => {
  assert.equal(countWords(""), 0);
  assert.equal(countWords("  one\ttwo\r\nthree\n\n four  "), 4);
  assert.equal(countWords('§4 "Index" — `pnpm check`'), 5);
});

test("passes at the limit and prints the count", () => {
  const { lines, io } = quiet();
  assert.equal(
    withFile(words(LIMIT), (file) => main([file], io)),
    0,
  );
  assert.match(lines.out[0], new RegExp(`${LIMIT} words \\(limit ${LIMIT}\\)`));
});

test("fails one word above the limit", () => {
  const { lines, io } = quiet();
  assert.equal(
    withFile(words(LIMIT + 1), (file) => main([file], io)),
    1,
  );
  assert.match(lines.err[0], new RegExp(`${LIMIT + 1} words, above the limit of ${LIMIT}`));
});

test("a file that cannot be read exits 2", () => {
  const { io } = quiet();
  assert.equal(main([join(tmpdir(), "design-size-missing-Usuário", "design.md")], io), 2);
});

test("run as a command, it sets the exit code", () => {
  const run = (n) =>
    withFile(words(n), (file) => spawnSync(process.execPath, [SCRIPT, file], { encoding: "utf8" }));
  const over = run(LIMIT + 1);
  assert.equal(over.status, 1, over.stderr);
  assert.match(over.stderr, /above the limit/);
  const within = run(10);
  assert.equal(within.status, 0, within.stderr);
  assert.match(within.stdout, /10 words/);
});
