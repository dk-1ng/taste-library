import { describe, expect, it } from "vitest";
import type { Json } from "../../test/support/library.js";
import { goldenSnapshot } from "../../test/support/snapshot.js";
import type { LibraryFileKind } from "../format.js";
import type { CrossFile } from "../validation/cross.js";
import type { FileStatus } from "../validation/file.js";
import type { Snapshot } from "../validation/library.js";
import { versionSummary } from "./versions.js";

const A = "ref-20261101-a1b2c3";

function crossFilesOf(snapshot: Snapshot): Map<string, CrossFile> {
  return new Map(
    [...snapshot.files].map(([path, file]) => [
      path,
      {
        kind: file.kind,
        status: file.status,
        formatVersion: file.formatVersion,
        value: file.value,
      },
    ]),
  );
}

const file = (kind: LibraryFileKind, status: FileStatus, formatVersion: number | null) => ({
  kind,
  status,
  formatVersion,
  value: null,
});

describe("versionSummary (format-spec §15.1, §15.2)", () => {
  it("the golden library: one version, nothing newer, nothing mixed", () => {
    expect(versionSummary(crossFilesOf(goldenSnapshot()), 1)).toEqual({
      library: 1,
      present: [1],
      newer: [],
      mixedFiles: [],
      needsMigration: false,
    });
  });

  it("a file of a newer version is listed as newer, and its version is present", () => {
    const snapshot = goldenSnapshot((files) => {
      (files.get(`references/${A}.json`) as Json).formatVersion = 2;
      (files.get("glossary.json") as Json).formatVersion = 3;
    });
    const summary = versionSummary(crossFilesOf(snapshot), 1);
    expect(summary.newer).toEqual(["glossary.json", `references/${A}.json`]);
    expect(summary.present).toEqual([1, 2, 3]);
    expect(summary.mixedFiles).toEqual([]);
  });

  it("an older library needs a migration", () => {
    const summary = versionSummary(crossFilesOf(goldenSnapshot()), 2);
    expect(summary).toMatchObject({ library: 1, needsMigration: true, mixedFiles: [] });
  });

  it("a file whose version differs from library.json is mixed, valid or not", () => {
    const files = new Map<string, CrossFile>([
      ["library.json", file("library", "valid", 2)],
      [`references/${A}.json`, file("reference", "valid", 1)],
      ["glossary.json", file("glossary", "invalid", 1)],
      ["guardrails.json", file("guardrails", "valid", 2)],
      ["taste-profile.json", file("taste-profile", "unreadable", null)],
      ["families/x.json", file("family", "invalid", null)],
    ]);
    expect(versionSummary(files, 2)).toEqual({
      library: 2,
      present: [1, 2],
      newer: [],
      mixedFiles: ["glossary.json", `references/${A}.json`],
      needsMigration: false,
    });
  });

  it("a library.json with errors leaves the library's version unknown", () => {
    const snapshot = goldenSnapshot((files) => void files.set("library.json", "{"));
    const summary = versionSummary(crossFilesOf(snapshot), 1);
    expect(summary).toMatchObject({ library: null, mixedFiles: [], needsMigration: false });
    expect(summary.present).toEqual([1]);
  });

  it("a newer library.json gives the library's version, and needs no migration", () => {
    const files = new Map<string, CrossFile>([
      ["library.json", file("library", "newer", 3)],
      ["glossary.json", file("glossary", "valid", 1)],
    ]);
    expect(versionSummary(files, 1)).toEqual({
      library: 3,
      present: [1, 3],
      newer: ["library.json"],
      mixedFiles: ["glossary.json"],
      needsMigration: false,
    });
  });
});
