import { describe, expect, it } from "vitest";
import { v1ToV2 } from "../../test/migrations/v1-to-v2.js";
import { TEST_REGISTRY } from "../../test/support/registry.js";
import { goldenFiles, goldenSnapshot, sha256 } from "../../test/support/snapshot.js";
import { FORMAT_REGISTRY, type FormatRegistry } from "../format.js";
import type { Snapshot } from "../validation/library.js";
import { type MigrationPlan, planMigration } from "./plan.js";
import type { LibraryValues, MigrationStep } from "./steps.js";

/**
 * The migration planner (format-spec §15.3 steps 1 to 3; docs/design.md section 15, "Format and
 * migration tests"): in memory, on snapshots of the golden v1 library under the test registry, whose
 * test-only step changes, adds and removes files.
 */

// biome-ignore lint/suspicious/noExplicitAny: tests read and edit arbitrary JSON
type Json = any;

const A = "ref-20261101-a1b2c3";
const decoder = new TextDecoder();
const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The golden v1 library under the test registry, edited by `edit`. */
function older(
  edit?: (files: Map<string, unknown>) => void,
  options: { unlisted?: string[]; unreadable?: string[]; registry?: FormatRegistry } = {},
): Snapshot {
  return goldenSnapshot(edit, { registry: TEST_REGISTRY, ...options });
}

function ready(plan: MigrationPlan): Extract<MigrationPlan, { status: "ready" }> {
  if (plan.status !== "ready")
    throw new Error(`expected a ready plan, got ${JSON.stringify(plan)}`);
  return plan;
}

/** The test registry with its step replaced by `change` applied to the test step's output. */
function brokenStep(change: (out: Map<string, unknown>) => void): FormatRegistry {
  const step: MigrationStep = (library: LibraryValues) => {
    const out = new Map(v1ToV2(library));
    change(out);
    return out;
  };
  return { ...TEST_REGISTRY, steps: { 1: step } };
}

describe("planMigration", () => {
  it("plans the golden v1 library: the files changed, added and removed, sorted, and a migrated snapshot with no issue", () => {
    const plan = ready(planMigration(TEST_REGISTRY, older(), sha256));
    const golden = [...goldenFiles().keys()];
    const terms = ((goldenFiles().get("glossary.json") as Json).terms as Json[]).map(
      (term) => `glossary/${term.id}.json`,
    );
    expect(terms.length).toBeGreaterThan(1);
    expect(plan.from).toBe(1);
    expect(plan.to).toBe(2);
    expect(plan.removed).toEqual(["glossary.json"]);
    expect(plan.added).toEqual([...terms].sort(compareText));
    expect(plan.changed).toEqual(golden.filter((path) => path !== "glossary.json"));
    // The bytes of every file to write, each in version 2's canonical form.
    expect([...plan.bytes.keys()]).toEqual([...plan.changed, ...plan.added].sort(compareText));
    const v2 = TEST_REGISTRY.versions[2];
    const migrated = v1ToV2(goldenFiles());
    for (const [path, bytes] of plan.bytes) {
      const kind = plan.migrated.files.get(path)?.kind ?? "";
      expect(decoder.decode(bytes), path).toBe(v2?.serialize(kind, migrated.get(path)));
    }

    const view = plan.migrated;
    expect(view.issues).toEqual([]);
    expect(view.formatVersion).toBe(2);
    expect(view.migrated).toBeNull();
    expect([...view.files.keys()]).toEqual([...migrated.keys()]);
    for (const file of view.files.values()) {
      expect([file.status, file.formatVersion, file.fingerprint], file.path).toEqual([
        "valid",
        2,
        null,
      ]);
      expect(file.bytes, file.path).toEqual(plan.bytes.get(file.path));
    }
    expect(view.files.get("projects/landing-redesign/project.json")?.value).toMatchObject({
      language: "en",
    });
  });

  it("gives identical bytes when it plans twice", () => {
    const first = ready(planMigration(TEST_REGISTRY, older(), sha256));
    const second = ready(planMigration(TEST_REGISTRY, older(), sha256));
    const bytes = (plan: typeof first) =>
      [...plan.bytes].map(([path, value]) => [path, decoder.decode(value)]);
    expect(bytes(second)).toEqual(bytes(first));
    expect([second.changed, second.added, second.removed]).toEqual([
      first.changed,
      first.added,
      first.removed,
    ]);
  });

  it("passes files already at version 2 through: they are neither changed nor added, and keep their bytes", () => {
    const family = "families/quiet-editorial.json";
    const term = "glossary/term-x2y4z6.json";
    const snapshot = older((files) => {
      (files.get(family) as Json).formatVersion = 2;
      const first = (files.get("glossary.json") as Json).terms[0];
      files.set(term, { formatVersion: 2, ...first, id: "term-x2y4z6" });
    });
    expect(snapshot.files.get(family)?.status).toBe("valid");
    expect(snapshot.files.get(term)?.status).toBe("valid");
    const plan = ready(planMigration(TEST_REGISTRY, snapshot, sha256));
    expect(plan.changed).not.toContain(family);
    expect(plan.changed).not.toContain(term);
    expect(plan.added).not.toContain(term);
    expect(plan.bytes.has(family)).toBe(false);
    expect(plan.migrated.files.get(family)?.bytes).toEqual(snapshot.files.get(family)?.bytes);
    expect(plan.migrated.files.get(term)?.bytes).toEqual(snapshot.files.get(term)?.bytes);
    expect(plan.changed).toContain(`references/${A}.json`);
  });

  it("does not change library.json in a mixed library whose library.json is already current", () => {
    const snapshot = older((files) => {
      (files.get("library.json") as Json).formatVersion = 2;
    });
    const plan = ready(planMigration(TEST_REGISTRY, snapshot, sha256));
    expect(plan.changed).not.toContain("library.json");
    expect(plan.bytes.has("library.json")).toBe(false);
    // The notice's `from` for such a library is the lowest version present (docs/design.md section 4, "Write gate").
    expect([plan.from, plan.to]).toEqual([1, 2]);
    expect(plan.changed).toContain(`references/${A}.json`);
    expect(plan.migrated.issues).toEqual([]);
  });

  it("is current for a library at the current version, in production and under the test registry", () => {
    expect(planMigration(FORMAT_REGISTRY, goldenSnapshot(), sha256)).toEqual({ status: "current" });
    const migrated = ready(planMigration(TEST_REGISTRY, older(), sha256)).migrated;
    expect(planMigration(TEST_REGISTRY, migrated, sha256)).toEqual({ status: "current" });
    // A current library with a broken file is still current: there is nothing to migrate.
    const broken = goldenSnapshot((files) => files.set(`references/${A}.json`, "{"));
    expect(planMigration(FORMAT_REGISTRY, broken, sha256)).toEqual({ status: "current" });
  });

  describe("blocks at step 1", () => {
    it("on a file with errors, with its issues", () => {
      const snapshot = older((files) => files.set(`references/${A}.json`, "{"));
      const plan = planMigration(TEST_REGISTRY, snapshot, sha256);
      expect(plan).toEqual({
        status: "blocked",
        step: 1,
        issues: snapshot.files.get(`references/${A}.json`)?.issues,
      });
      expect(plan.status === "blocked" && plan.issues[0]?.code).toBe("invalid-json");
    });

    it("on a file that cannot be read", () => {
      const snapshot = older(undefined, { unreadable: ["guardrails.json"] });
      expect(planMigration(TEST_REGISTRY, snapshot, sha256)).toEqual({
        status: "blocked",
        step: 1,
        issues: [expect.objectContaining({ code: "unreadable-file", file: "guardrails.json" })],
      });
    });

    it("on a folder that could not be listed, so not every file was read", () => {
      const snapshot = older(undefined, { unlisted: ["families"] });
      expect(planMigration(TEST_REGISTRY, snapshot, sha256)).toEqual({
        status: "blocked",
        step: 1,
        issues: [expect.objectContaining({ code: "unreadable-file", file: "families" })],
      });
    });

    it("on a folder that could not be listed even when its issue is not given", () => {
      const snapshot = older(undefined, { unlisted: ["families"] });
      expect(planMigration(TEST_REGISTRY, { ...snapshot, issues: [] }, sha256)).toEqual({
        status: "blocked",
        step: 1,
        issues: [],
      });
    });

    it("on a file of a newer version, and lists every blocking file, sorted", () => {
      const snapshot = older((files) => {
        (files.get("taste-profile.json") as Json).formatVersion = 3;
        files.set("guardrails.json", "[");
      });
      const plan = planMigration(TEST_REGISTRY, snapshot, sha256);
      expect(plan.status === "blocked" && plan.issues.map((i) => [i.code, i.file])).toEqual([
        ["invalid-json", "guardrails.json"],
        ["newer-format", "taste-profile.json"],
      ]);
    });

    it("on a glossary.json at version 2, a path version 2 does not have", () => {
      const snapshot = older((files) => {
        (files.get("glossary.json") as Json).formatVersion = 2;
      });
      const plan = planMigration(TEST_REGISTRY, snapshot, sha256);
      expect(plan).toMatchObject({ status: "blocked", step: 1 });
      expect(
        plan.status === "blocked" && plan.issues.map((i) => [i.code, i.file, i.pointer]),
      ).toEqual([["schema-violation", "glossary.json", "/formatVersion"]]);
    });
  });

  describe("blocks at step 3", () => {
    it("on a value the step made invalid, at its migrated path, saying it was found after migration", () => {
      // The term file exists only after the migration.
      const registry = brokenStep((out) => {
        (out.get("glossary/term-2b4d6f.json") as Json).pieces = "not a list";
      });
      const plan = planMigration(registry, older(), sha256);
      expect(plan).toMatchObject({ status: "blocked", step: 3 });
      if (plan.status !== "blocked") return;
      expect(plan.issues.map((i) => [i.severity, i.code, i.file, i.pointer])).toEqual([
        ["error", "schema-violation", "glossary/term-2b4d6f.json", "/pieces"],
      ]);
      expect(plan.issues[0]?.message).toMatch(/\(found after migration to version 2\)\.$/);
    });

    it("on a link inside a file the step left pointing to nothing", () => {
      const registry = brokenStep((out) => {
        const reference = out.get(`references/${A}.json`) as Json;
        reference.interpretations = {
          ...reference.interpretations,
          p9: reference.interpretations.p0,
        };
      });
      const plan = planMigration(registry, older(), sha256);
      expect(plan).toMatchObject({ status: "blocked", step: 3 });
      expect(
        plan.status === "blocked" && plan.issues.map((i) => [i.code, i.file, i.pointer]),
      ).toEqual([["broken-local-link", `references/${A}.json`, "/interpretations/p9"]]);
    });

    it("on a file the step left at an older version, valid at its own but not at the current one", () => {
      const registry = brokenStep((out) => {
        out.set(`references/${A}.json`, goldenFiles().get(`references/${A}.json`));
      });
      const plan = planMigration(registry, older(), sha256);
      expect(plan).toMatchObject({ status: "blocked", step: 3 });
      expect(
        plan.status === "blocked" && plan.issues.map((i) => [i.code, i.file, i.pointer]),
      ).toEqual([["schema-violation", `references/${A}.json`, "/formatVersion"]]);
    });

    it("but not on a link to another file the step left dangling, which is a warning (format-spec §16.2)", () => {
      const registry = brokenStep((out) => {
        (out.get("families/quiet-editorial.json") as Json).members[0].target =
          "ref-20261231-zzzzzz#p0";
      });
      const plan = ready(planMigration(registry, older(), sha256));
      // The member is reported where the canonical form puts it (members are sorted).
      const family = plan.migrated.files.get("families/quiet-editorial.json");
      if (family === undefined) throw new Error("no family");
      const members = (family.value as Json).members as Json[];
      const index = members.findIndex((member) => member.target === "ref-20261231-zzzzzz#p0");
      expect(index).toBeGreaterThanOrEqual(0);
      expect(plan.migrated.issues.map((i) => [i.severity, i.code, i.file, i.pointer])).toEqual([
        ["warning", "dangling-link", "families/quiet-editorial.json", `/members/${index}/target`],
      ]);
    });
  });

  it("throws for a step that gives a path outside the current layout or with ..", () => {
    for (const path of [
      "notes/x.json",
      "references/../library.json",
      "projects/../x/project.json",
      "references/./x.json",
      "references\\x.json",
      "glossary.json",
    ]) {
      const registry = brokenStep((out) => {
        out.set(path, { formatVersion: 2 });
      });
      expect(() => planMigration(registry, older(), sha256), path).toThrow(/path/);
    }
  });

  it("never changes the snapshot it plans from", () => {
    const snapshot = older();
    const before = [...snapshot.files].map(([path, file]) => [path, JSON.stringify(file.value)]);
    ready(planMigration(TEST_REGISTRY, snapshot, sha256));
    expect([...snapshot.files].map(([path, file]) => [path, JSON.stringify(file.value)])).toEqual(
      before,
    );
  });
});
