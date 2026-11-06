import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { TEST_REGISTRY } from "../../test/support/registry.js";
import { goldenSnapshot } from "../../test/support/snapshot.js";
import { FORMAT_REGISTRY } from "../format.js";
import { planMigration } from "../migrations/plan.js";
import { makeIssue } from "./issue.js";
import {
  assembleSnapshot,
  buildSnapshot,
  checkEntry,
  type LibraryEntry,
  type Snapshot,
} from "./library.js";

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const encoder = new TextEncoder();

/** The golden files as entries, plus one file that cannot be read and one with errors. */
function entries(): LibraryEntry[] {
  const snapshot = goldenSnapshot();
  const out: LibraryEntry[] = [...snapshot.files.values()].map((file) => ({
    path: file.path,
    kind: file.kind,
    read: { status: "ok", bytes: file.bytes as Uint8Array },
  }));
  out.push({
    path: "families/broken.json",
    kind: "family",
    read: { status: "ok", bytes: encoder.encode("{") },
  });
  out.push({
    path: "families/locked.json",
    kind: "family",
    read: {
      status: "failed",
      issue: makeIssue(
        "unreadable-file",
        "families/locked.json",
        null,
        "The file cannot be read (EACCES).",
      ),
    },
  });
  return out.reverse();
}

/** The snapshot without the one function it holds (`targets.resolve`), so `toEqual` compares data. */
const data = (snapshot: Snapshot) => ({
  ...snapshot,
  index: { ...snapshot.index, targets: { ...snapshot.index.targets, resolve: null } },
});

describe("checkEntry and assembleSnapshot", () => {
  it("give the snapshot buildSnapshot gives", () => {
    const folderIssues = [makeIssue("unexpected-file", "references/notes.txt", null, "x")];
    const built = buildSnapshot(FORMAT_REGISTRY, entries(), folderIssues, sha256, ["projects/x"]);
    const assembled = assembleSnapshot(
      FORMAT_REGISTRY,
      entries().map((entry) => checkEntry(FORMAT_REGISTRY, entry)),
      folderIssues,
      sha256,
      ["projects/x"],
    );
    expect(data(assembled)).toEqual(data(built));
    expect([...assembled.files.keys()]).toEqual([...built.files.keys()]);
    expect(built.files.get("families/locked.json")?.status).toBe("unreadable");
    expect(built.files.get("families/broken.json")?.status).toBe("invalid");
  });

  it("keeps the fingerprint of an entry, and null without one", () => {
    const [entry] = entries();
    if (entry === undefined) throw new Error("no entry");
    expect(checkEntry(FORMAT_REGISTRY, entry).fingerprint).toBeNull();
    expect(checkEntry(FORMAT_REGISTRY, { ...entry, fingerprint: "1:2:3:4" }).fingerprint).toBe(
      "1:2:3:4",
    );
  });

  it("puts the index in the snapshot", () => {
    const snapshot = goldenSnapshot();
    expect(snapshot.index.versions).toEqual({
      library: 1,
      present: [1],
      newer: [],
      mixedFiles: [],
      needsMigration: false,
    });
    expect(snapshot.index.references.get("ref-20261103-g7h8j9")?.state).toBe("reviewed");
    expect(snapshot.index.backlinks.get("family:quiet-editorial")?.length).toBe(1);
  });
});

describe('the migrated view (docs/design.md section 3, "Core modules and API")', () => {
  // biome-ignore lint/suspicious/noExplicitAny: tests edit arbitrary JSON
  type Json = any;
  const older = (edit?: (files: Map<string, unknown>) => void) =>
    goldenSnapshot(edit, { registry: TEST_REGISTRY });

  it("is null for a current library, and the planner's migrated library for an older one", () => {
    expect(goldenSnapshot().migrated).toBeNull();
    const snapshot = older();
    const plan = planMigration(TEST_REGISTRY, snapshot, sha256);
    if (plan.status !== "ready" || snapshot.migrated === null) throw new Error("no migrated view");
    expect(data(snapshot.migrated)).toEqual(data(plan.migrated));
  });

  it("puts in the report the issues of the files on disk once, the version issues, and the issues across files of the migrated library at their migrated paths", () => {
    const family = "families/dense-dashboards.json";
    const snapshot = older((files) => {
      // A file already at version 2, not canonical: the migration keeps it as it is, so the
      // migrated library has its warning too, which the report holds once.
      const value = files.get(family) as Json;
      files.set(family, JSON.stringify({ ...value, formatVersion: 2 }));
      (files.get("families/quiet-editorial.json") as Json).members[1].target =
        "ref-20261101-a1b2c3#p9";
    });
    expect(snapshot.migrated).not.toBeNull();
    expect(snapshot.issues.map((i) => [i.severity, i.code, i.file, i.pointer])).toEqual([
      ["info", "needs-migration", null, null],
      ["warning", "not-canonical", family, null],
      ["warning", "mixed-format-versions", family, "/formatVersion"],
      ["warning", "dangling-link", "families/quiet-editorial.json", "/members/1/target"],
    ]);
    const [, notCanonical, , dangling] = snapshot.issues;
    expect(notCanonical?.message).not.toMatch(/after migration/);
    expect(dangling?.message).toMatch(/\(found after migration to version 2\)\.$/);
  });

  it("gives the index from the migrated library, with the version summary of the files on disk", () => {
    const snapshot = older();
    const migrated = snapshot.migrated;
    if (migrated === null) throw new Error("no migrated view");
    expect(snapshot.index.references).toBe(migrated.index.references);
    expect(snapshot.index.familiesOf).toBe(migrated.index.familiesOf);
    expect(snapshot.index.backlinks).toBe(migrated.index.backlinks);
    expect(snapshot.index.versions).toMatchObject({ library: 1, needsMigration: true });
    expect(migrated.index.versions).toMatchObject({ library: 2, needsMigration: false });
  });
});
