import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { goldenSnapshot } from "../../test/support/snapshot.js";
import { FORMAT_REGISTRY } from "../format.js";
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
