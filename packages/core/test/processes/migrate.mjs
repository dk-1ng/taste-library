/**
 * A child process that migrates a library, for the race of the migration claim between real
 * processes (docs/design.md section 15, "Core test approach", "Concurrency"; format-spec §15.3
 * step 4). Test-only: it imports the built `dist/`, so the test script builds first.
 *
 * Usage: `node migrate.mjs <library folder>`. It opens the library with a tiny registry that adds
 * a version 2 (below), then runs `library.migrate` with the real host name and process id. It
 * talks with the test in lines, JSON on stdout and words on stdin:
 *
 * - at the runner's `before-claim` point it prints `{"event":"ready"}` and waits for `go`, so every
 *   process has planned on the library at version 1 before any of them claims;
 * - at `claimed` (it won the non-recursive `mkdir`) it prints `{"event":"claimed"}` and waits for
 *   `finish`, so the others can only meet its claim, never a backup it already deleted;
 * - at the end it prints `{"event":"result","result":<the migrate result>}`, or
 *   `{"event":"error","message":...}` with exit code 1 when something threw.
 *
 * If stdin closes while it waits (the test is gone), it exits with code 2.
 */

import { createInterface } from "node:readline";
import { z } from "zod";
import { FORMAT_REGISTRY, openLibrary } from "../../dist/index.js";

const say = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);

const lines = createInterface({ input: process.stdin });
const queued = [];
const waiting = [];
lines.on("line", (line) => {
  const next = waiting.shift();
  if (next === undefined) queued.push(line.trim());
  else next(line.trim());
});
lines.on("close", () => {
  if (waiting.length > 0) process.exit(2);
});

/** Waits for the next line from the test, which must be `word`. */
async function expectLine(word) {
  const line =
    queued.length > 0 ? queued.shift() : await new Promise((resolve) => waiting.push(resolve));
  if (line !== word) throw new Error(`Expected "${word}" from the test, got "${line}".`);
}

/**
 * A registry with a version 2 on top of the production version 1: each kind's version 1 schema
 * with `formatVersion` 2, the same layout, and a step that sets `formatVersion` 2 in every file at
 * version 1 (zod keeps the position of a key it overwrites, and so does a spread). The test-only
 * registry of the unit tests is TypeScript under `test/`, which is never built into `dist/`.
 */
function registryWithVersion2() {
  const v1 = FORMAT_REGISTRY.versions[1];
  const schemas = Object.fromEntries(
    Object.entries(v1.schemas).map(([kind, schema]) => [
      kind,
      kind === "marker" ? schema : schema.safeExtend({ formatVersion: z.literal(2) }),
    ]),
  );
  const canonicalize = (kind, value) => {
    schemas[kind].parse(value);
    return { ...v1.canonicalize(kind, { ...value, formatVersion: 1 }), formatVersion: 2 };
  };
  const step = (library) =>
    new Map(
      [...library]
        .map(([path, value]) => [
          path,
          value?.formatVersion === 1 ? { ...structuredClone(value), formatVersion: 2 } : value,
        ])
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    );
  return {
    current: 2,
    versions: {
      1: v1,
      2: {
        schemas,
        layout: v1.layout,
        canonicalize,
        serialize: (kind, value) => `${JSON.stringify(canonicalize(kind, value), null, 2)}\n`,
      },
    },
    steps: { 1: step },
  };
}

async function main() {
  const root = process.argv[2];
  if (root === undefined) throw new Error("Usage: node migrate.mjs <library folder>");
  const opened = await openLibrary(root, { registry: registryWithVersion2() });
  if (!opened.ok) throw new Error(opened.message);
  const result = await opened.library.migrate({
    at: async (point) => {
      if (point === "before-claim") {
        say({ event: "ready" });
        await expectLine("go");
      } else if (point === "claimed") {
        say({ event: "claimed" });
        await expectLine("finish");
      }
    },
  });
  say({ event: "result", result });
}

try {
  await main();
} catch (error) {
  say({
    event: "error",
    message: error instanceof Error ? (error.stack ?? error.message) : String(error),
  });
  process.exitCode = 1;
} finally {
  lines.close();
  process.stdin.destroy();
}
