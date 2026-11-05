import { describe, expect, it } from "vitest";
import { classifyEntry, currentLayout, FORMAT_REGISTRY } from "./format.js";

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
