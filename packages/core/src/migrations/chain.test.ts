import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { goldenDir, readTree } from "../../test/support/golden.js";
import { TEST_REGISTRY } from "../../test/support/registry.js";
import {
  applySteps,
  CURRENT_FORMAT_VERSION,
  currentLayout,
  FORMAT_REGISTRY,
  type FormatRegistry,
  kindOfPath,
} from "../format.js";
import { checkLibraryFile } from "../validation/file.js";
import { buildSnapshot, type LibraryEntry } from "../validation/library.js";

/**
 * The chain test (docs/design.md section 15, "Format and migration tests" and "Core test
 * approach"): every version up to the current one has its schema folder, its golden library and,
 * above version 1, its step module, and every golden library migrates through the chain to the
 * current version and validates. The same chain logic runs once with the test registry, so it is
 * exercised with a real step before the first real one exists.
 */

const PACKAGE = join(import.meta.dirname, "..", "..");
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** `[1, 2, …, last]`. */
const upTo = (last: number): number[] => Array.from({ length: last }, (_, index) => index + 1);

/** The keys of a record of versions, as numbers in ascending order. */
const versionsOf = (record: Readonly<Record<number, unknown>>): number[] =>
  Object.keys(record)
    .map(Number)
    .sort((a, b) => a - b);

/** The registry has versions 1 to `current`, and a step from each version below `current`, and nothing else. */
function expectChainShape(registry: FormatRegistry): void {
  expect(versionsOf(registry.versions)).toEqual(upTo(registry.current));
  expect(versionsOf(registry.steps)).toEqual(upTo(registry.current - 1));
}

/**
 * Migrates the golden library of version `from` through the registry's chain and validates the
 * result as the current version: each file first against the schemas of its own version (no
 * issue at all, since a golden library is clean), then the migrated library as a whole, each file
 * written in the current version's canonical form, with the checks across files.
 */
async function expectGoldenMigrates(registry: FormatRegistry, from: number): Promise<void> {
  const own = registry.versions[from];
  if (own === undefined) throw new Error(`The registry has no version ${from}.`);
  const values = new Map<string, unknown>();
  for (const [path, bytes] of await readTree(join(PACKAGE, "test", "golden", `v${from}`))) {
    const kind = kindOfPath(own.layout, path);
    expect(kind, path).not.toBeNull();
    if (kind === null) continue;
    const checked = checkLibraryFile(registry, kind, path, bytes);
    expect([checked.status, checked.formatVersion, checked.issues], path).toEqual([
      "valid",
      from,
      [],
    ]);
    values.set(path, JSON.parse(decoder.decode(bytes)));
  }

  const migrated = applySteps(registry, values, from);
  const spec = registry.versions[registry.current];
  if (spec === undefined) throw new Error(`The registry has no version ${registry.current}.`);
  const layout = currentLayout(registry);
  const entries: LibraryEntry[] = [];
  for (const [path, value] of migrated) {
    const kind = kindOfPath(layout, path);
    expect(kind, `${path} is a file of version ${registry.current}`).not.toBeNull();
    if (kind === null) continue;
    entries.push({
      path,
      kind,
      read: { status: "ok", bytes: encoder.encode(spec.serialize(kind, value)) },
    });
  }
  const snapshot = buildSnapshot(registry, entries, [], sha256);
  expect(snapshot.issues).toEqual([]);
  expect(snapshot.formatVersion).toBe(registry.current);
  for (const file of snapshot.files.values()) {
    expect([file.status, file.formatVersion], file.path).toEqual(["valid", registry.current]);
  }
}

describe("the chain of format versions", () => {
  it("is at version 1 with no step in production, so no test-only step or schema is reachable from dist/", () => {
    expect(CURRENT_FORMAT_VERSION).toBe(1);
    expect(FORMAT_REGISTRY.current).toBe(1);
    expect(FORMAT_REGISTRY.steps).toEqual({});
    expect(versionsOf(FORMAT_REGISTRY.versions)).toEqual([1]);
  });

  it("has versions 1 to the current one and a step from each version below it, and no other", () => {
    expect(FORMAT_REGISTRY.current).toBe(CURRENT_FORMAT_VERSION);
    expectChainShape(FORMAT_REGISTRY);
  });

  it("has a schema folder and a golden library for every version, and a step module above version 1", () => {
    for (const version of upTo(CURRENT_FORMAT_VERSION)) {
      expect(
        existsSync(join(PACKAGE, "src", "schemas", `v${version}`, "set.ts")),
        `v${version}`,
      ).toBe(true);
      expect(existsSync(join(goldenDir(version), "library.json")), `golden v${version}`).toBe(true);
      if (version > 1) {
        const step = join(PACKAGE, "src", "migrations", `v${version - 1}-to-v${version}.ts`);
        expect(existsSync(step), step).toBe(true);
      }
    }
  });

  it("migrates every golden library to the current version, and it validates with no issue", async () => {
    for (const version of upTo(CURRENT_FORMAT_VERSION)) {
      await expectGoldenMigrates(FORMAT_REGISTRY, version);
    }
  });

  it("at version 1, leaves the golden library byte for byte as it is", async () => {
    const golden = await readTree(goldenDir(1));
    const values = new Map(
      [...golden].map(([path, bytes]) => [path, JSON.parse(decoder.decode(bytes))]),
    );
    const migrated = applySteps(FORMAT_REGISTRY, values, 1);
    const spec = FORMAT_REGISTRY.versions[1];
    if (spec === undefined) throw new Error("no version 1");
    const layout = currentLayout(FORMAT_REGISTRY);
    for (const [path, value] of migrated) {
      const kind = kindOfPath(layout, path);
      if (kind === null) throw new Error(`${path} is not a file of version 1`);
      expect(spec.serialize(kind, value), path).toBe(decoder.decode(golden.get(path)));
    }
    expect([...migrated.keys()]).toEqual([...golden.keys()]);
  });

  describe("with the test registry (a test-only version 2)", () => {
    it("has the same shape: versions 1 and 2 and the one step between them", () => {
      expect(TEST_REGISTRY.current).toBe(2);
      expectChainShape(TEST_REGISTRY);
    });

    it("migrates the golden v1 library through the test step, and it validates with no issue", async () => {
      await expectGoldenMigrates(TEST_REGISTRY, 1);
    });
  });
});
