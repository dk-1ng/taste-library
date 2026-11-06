import { describe, expect, it } from "vitest";
import { TEST_REGISTRY } from "../test/support/registry.js";
import {
  applySteps,
  classifyEntry,
  classifyListedEntry,
  currentLayout,
  FORMAT_REGISTRY,
  type FormatLayout,
  type FormatRegistry,
  type FormatVersionSpec,
  kindOfPath,
  layoutKindOf,
} from "./format.js";
import type { LibraryValues } from "./migrations/steps.js";

const layout = currentLayout(FORMAT_REGISTRY);
const classify = (parent: string, name: string, directory = false) =>
  classifyEntry(layout, parent, name, directory);

describe("classifyEntry", () => {
  it("finds the files and folders at the top of the library and ignores the rest", () => {
    expect(classify("", "library.json")).toEqual({ type: "file", kind: "library" });
    expect(classify("", "glossary.json")).toEqual({ type: "file", kind: "glossary" });
    expect(classify("", "guardrails.json")).toEqual({ type: "file", kind: "guardrails" });
    expect(classify("", "taste-profile.json")).toEqual({ type: "file", kind: "taste-profile" });
    for (const name of ["references", "families", "projects"]) {
      expect(classify("", name, true)).toEqual({ type: "folder" });
      expect(classify("", name, false)).toEqual({ type: "ignore" });
    }
    for (const name of [
      ".tastelib",
      "README.md",
      ".git",
      ".gitignore",
      "constructor",
      "__proto__",
    ]) {
      expect(classify("", name, true), name).toEqual({ type: "ignore" });
      expect(classify("", name, false), name).toEqual({ type: "ignore" });
    }
  });

  it("finds a file per thing in references/ and families/", () => {
    expect(classify("references", "ref-20261104-k3x9ab.json")).toEqual({
      type: "file",
      kind: "reference",
    });
    expect(classify("families", "quiet-editorial.json")).toEqual({ type: "file", kind: "family" });
    expect(classify("references", "notes.txt")).toEqual({ type: "unexpected" });
    expect(classify("references", "sub", true)).toEqual({ type: "unexpected" });
    expect(classify("references", "sub.json", true)).toEqual({ type: "unexpected" });
  });

  it("finds one folder per project with project.json and directions.json", () => {
    expect(classify("projects", "landing", true)).toEqual({ type: "folder" });
    expect(classify("projects", "loose.json")).toEqual({ type: "unexpected" });
    expect(classify("projects/landing", "project.json")).toEqual({ type: "file", kind: "project" });
    expect(classify("projects/landing", "directions.json")).toEqual({
      type: "file",
      kind: "directions",
    });
    expect(classify("projects/landing", "other.json")).toEqual({ type: "unexpected" });
    expect(classify("projects/landing", "project.json", true)).toEqual({ type: "unexpected" });
    expect(classify("projects/landing", "constructor")).toEqual({ type: "unexpected" });
  });

  it("recognizes a leftover temporary file by its name, in every format folder", () => {
    for (const parent of ["references", "families", "projects", "projects/landing"]) {
      expect(classify(parent, ".x.json.tmp-0a1b2c3d"), parent).toEqual({
        type: "leftover-temp-file",
      });
    }
    expect(classify("references", ".x.json.tmp-0a1b2c3")).toEqual({ type: "unexpected" }); // 7 characters
    expect(classify("references", ".x.json.tmp-0A1B2C3D")).toEqual({ type: "unexpected" }); // not lowercase
    expect(classify("references", ".x.json.tmp-0i1l2o3u")).toEqual({ type: "unexpected" }); // not Crockford
    expect(classify("", ".glossary.json.tmp-0a1b2c3d")).toEqual({ type: "ignore" }); // the top level is not a format folder
  });

  it("names the identifier a path gives and the field that must repeat it", () => {
    expect(layout.identityOf("references/ref-20261104-k3x9ab.json", "reference")).toEqual({
      name: "ref-20261104-k3x9ab",
      field: "id",
    });
    expect(layout.identityOf("families/quiet.json", "family")).toEqual({
      name: "quiet",
      field: "slug",
    });
    expect(layout.identityOf("projects/landing/project.json", "project")).toEqual({
      name: "landing",
      field: "slug",
    });
    expect(layout.identityOf("projects/landing/directions.json", "directions")).toBeNull();
    expect(layout.identityOf("glossary.json", "glossary")).toBeNull();
  });
});

describe("classifyListedEntry (the union of the layouts of every version, format-spec §15.2)", () => {
  const listed = (registry: FormatRegistry, parent: string, name: string, directory = false) =>
    classifyListedEntry(registry, parent, name, directory);

  it("gives what version 1's layout gives in the production registry", () => {
    for (const [parent, name, directory] of [
      ["", "library.json", false],
      ["", "glossary.json", false],
      ["", "references", true],
      ["", "references", false],
      ["", "README.md", false],
      ["", "constructor", true],
      ["references", "ref-20261104-k3x9ab.json", false],
      ["references", "notes.txt", false],
      ["references", ".x.json.tmp-0a1b2c3d", false],
      ["projects", "landing", true],
      ["projects/landing", "project.json", false],
      ["projects/landing", "other.json", false],
      ["glossary", "term-2b4d6f.json", false],
    ] as const) {
      expect(listed(FORMAT_REGISTRY, parent, name, directory), `${parent}/${name}`).toEqual(
        classify(parent, name, directory),
      );
    }
  });

  it("lists a path that only an older version has, and a path that only the newer one has", () => {
    // glossary.json is a file of version 1 only; glossary/<term-id>.json of version 2 only.
    expect(listed(TEST_REGISTRY, "", "glossary.json")).toEqual({ type: "file", kind: "glossary" });
    expect(listed(TEST_REGISTRY, "", "glossary", true)).toEqual({ type: "folder" });
    expect(listed(TEST_REGISTRY, "glossary", "term-2b4d6f.json")).toEqual({
      type: "file",
      kind: "glossary-term",
    });
    expect(listed(TEST_REGISTRY, "references", "ref-20261104-k3x9ab.json")).toEqual({
      type: "file",
      kind: "reference",
    });
    expect(listed(TEST_REGISTRY, "glossary", "notes.txt")).toEqual({ type: "unexpected" });
    expect(listed(TEST_REGISTRY, "glossary", ".x.json.tmp-0a1b2c3d")).toEqual({
      type: "leftover-temp-file",
    });
    expect(listed(TEST_REGISTRY, "", "README.md")).toEqual({ type: "ignore" });
    expect(listed(TEST_REGISTRY, "", "glossary")).toEqual({ type: "ignore" });
  });

  it("takes each path's kind from the newest version whose layout has it", () => {
    const v1 = FORMAT_REGISTRY.versions[1] ?? fail("no version 1");
    const renamed: FormatVersionSpec = {
      ...v1,
      layout: { ...v1.layout, files: { ...v1.layout.files, "guardrails.json": "rules" } },
    };
    const registry: FormatRegistry = {
      current: 3,
      versions: { 1: v1, 2: renamed, 3: v1 },
      steps: {},
    };
    expect(listed(registry, "", "guardrails.json")).toEqual({ type: "file", kind: "guardrails" });
    const newest: FormatRegistry = { ...registry, versions: { 1: v1, 2: v1, 3: renamed } };
    expect(listed(newest, "", "guardrails.json")).toEqual({ type: "file", kind: "rules" });
    // A current version without the path: the newest older version that has it decides.
    const { "guardrails.json": _gone, ...files } = v1.layout.files;
    const without: FormatVersionSpec = { ...v1, layout: { ...v1.layout, files } };
    const older: FormatRegistry = { ...registry, versions: { 1: v1, 2: renamed, 3: without } };
    expect(listed(older, "", "guardrails.json")).toEqual({ type: "file", kind: "rules" });
  });
});

describe("layoutKindOf and kindOfPath", () => {
  const v1 = FORMAT_REGISTRY.versions[1] ?? fail("no version 1");
  const v2 = TEST_REGISTRY.versions[2] ?? fail("no version 2");

  it("give the kind of a path in one version's layout, or null", () => {
    for (const kindOf of [layoutKindOf, kindOfPath]) {
      expect(kindOf(v1.layout, "glossary.json")).toBe("glossary");
      expect(kindOf(v2.layout, "glossary.json")).toBeNull();
      expect(kindOf(v2.layout, "glossary/term-2b4d6f.json")).toBe("glossary-term");
      expect(kindOf(v1.layout, "glossary/term-2b4d6f.json")).toBeNull();
      expect(kindOf(v1.layout, "projects/landing/directions.json")).toBe("directions");
      expect(kindOf(v1.layout, "projects/../directions.json")).toBeNull();
      expect(kindOf(v1.layout, "projects/./directions.json")).toBeNull();
      expect(kindOf(v1.layout, "references/../library.json")).toBeNull();
      expect(kindOf(v1.layout, "references//x.json")).toBeNull();
      expect(kindOf(v1.layout, "references/.x.json.tmp-abcdefgh")).toBeNull();
      expect(kindOf(v1.layout, "notes.txt")).toBeNull();
    }
  });

  it("kindOfPath alone also refuses a project folder that is not a slug", () => {
    const path = "projects/Not A Slug/project.json";
    expect(layoutKindOf(v1.layout, path)).toBe("project");
    expect(kindOfPath(v1.layout, path)).toBeNull();
  });
});

function fail(message: string): never {
  throw new Error(message);
}

/** Every kind a layout names. */
function kindsOf(layout: FormatLayout): string[] {
  const kinds = [
    ...Object.values(layout.files),
    ...Object.values(layout.flatFolders),
    ...Object.values(layout.nestedFolders).flatMap((files) => Object.values(files)),
  ];
  return [...new Set(kinds)].sort();
}

describe("the file kinds of each version", () => {
  for (const [name, registry] of [
    ["production", FORMAT_REGISTRY],
    ["test", TEST_REGISTRY],
  ] as const) {
    it(`are the same in the layout and the schema set, in the ${name} registry`, () => {
      for (const [version, spec] of Object.entries(registry.versions)) {
        const schemaKinds = Object.keys(spec.schemas)
          .filter((kind) => kind !== "marker")
          .sort();
        expect(kindsOf(spec.layout), `version ${version}`).toEqual(schemaKinds);
      }
    });
  }

  it("lets a later version add a kind and drop a path (the test version 2)", () => {
    const v2 = TEST_REGISTRY.versions[2];
    if (v2 === undefined) throw new Error("no version 2");
    expect(classifyEntry(v2.layout, "", "glossary", true)).toEqual({ type: "folder" });
    expect(classifyEntry(v2.layout, "glossary", "term-2b4d6f.json", false)).toEqual({
      type: "file",
      kind: "glossary-term",
    });
    expect(classifyEntry(v2.layout, "", "glossary.json", false)).toEqual({ type: "ignore" });
    expect(v2.layout.identityOf("glossary/term-2b4d6f.json", "glossary-term")).toEqual({
      name: "term-2b4d6f",
      field: "id",
    });
  });

  it("version 1's canonical form refuses a kind version 1 does not have", () => {
    const v1 = FORMAT_REGISTRY.versions[1];
    if (v1 === undefined) throw new Error("no version 1");
    for (const kind of ["glossary-term", "marker", "constructor"]) {
      expect(() => v1.serialize(kind, {}), kind).toThrow(/not a kind of file of format version 1/);
      expect(() => v1.canonicalize(kind, {}), kind).toThrow(/not a kind of file/);
    }
  });
});

describe("applySteps", () => {
  const v1: FormatVersionSpec = FORMAT_REGISTRY.versions[1] ?? fail("no version 1");
  /** A registry at version 4 whose steps record their order and mark every file with their version. */
  function recording(): { registry: FormatRegistry; calls: number[] } {
    const calls: number[] = [];
    const step =
      (from: number) =>
      (library: LibraryValues): LibraryValues => {
        calls.push(from);
        return new Map([...library].map(([path, value]) => [path, [value, from + 1]]));
      };
    return {
      calls,
      registry: {
        current: 4,
        versions: { 1: v1, 2: v1, 3: v1, 4: v1 },
        steps: { 1: step(1), 2: step(2), 3: step(3) },
      },
    };
  }
  const library: LibraryValues = new Map([["library.json", "start"]]);

  it("applies the steps from the given version up to the current one, in order", () => {
    const { registry, calls } = recording();
    expect([...applySteps(registry, library, 1)]).toEqual([
      ["library.json", [[["start", 2], 3], 4]],
    ]);
    expect(calls).toEqual([1, 2, 3]);
  });

  it("starts at the given version, so a library already at version 3 takes only the last step", () => {
    const { registry, calls } = recording();
    expect([...applySteps(registry, library, 3)]).toEqual([["library.json", ["start", 4]]]);
    expect(calls).toEqual([3]);
  });

  it("returns the library itself when it is at the current version", () => {
    const { registry, calls } = recording();
    expect(applySteps(registry, library, 4)).toBe(library);
    expect(applySteps(FORMAT_REGISTRY, library, 1)).toBe(library);
    expect(calls).toEqual([]);
  });

  it("throws for a version outside the registry or a missing step, which are bugs", () => {
    const { registry } = recording();
    for (const from of [0, 5, 1.5, Number.NaN]) {
      expect(() => applySteps(registry, library, from), String(from)).toThrow(
        /not a format version/,
      );
    }
    const gap: FormatRegistry = { ...registry, steps: { 1: (l) => l, 3: (l) => l } };
    expect(() => applySteps(gap, library, 1)).toThrow(/no step from version 2/);
  });
});
