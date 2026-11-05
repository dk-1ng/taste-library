import { describe, expect, it } from "vitest";
import { FORMAT_REGISTRY } from "../format.js";
import { serialize } from "../json/canonical.js";
import { checkLibraryFile } from "./file.js";

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const library = {
  formatVersion: 1,
  id: "lib-9k3m7q2x4a",
  name: "Test",
  language: "en",
  createdAt: "2026-11-01T09:00:00.000Z",
};

describe("checkLibraryFile", () => {
  it("accepts a canonical file", () => {
    const check = checkLibraryFile(
      FORMAT_REGISTRY,
      "library",
      "library.json",
      bytes(serialize("library", library)),
    );
    expect(check).toMatchObject({ status: "valid", formatVersion: 1, issues: [], value: library });
  });

  it("keeps a file that is valid but not canonical valid, with a warning", () => {
    const check = checkLibraryFile(
      FORMAT_REGISTRY,
      "library",
      "library.json",
      bytes(`${JSON.stringify(library)}\n`),
    );
    expect(check.status).toBe("valid");
    expect(check.issues).toMatchObject([
      { code: "not-canonical", severity: "warning", file: "library.json", pointer: null },
    ]);
  });

  it("is invalid with the reader's issues for bytes that are not JSON, with no version", () => {
    const check = checkLibraryFile(FORMAT_REGISTRY, "library", "library.json", bytes("{"));
    expect(check).toMatchObject({ status: "invalid", formatVersion: null, value: null });
    expect(check.issues[0]).toMatchObject({ code: "invalid-json", severity: "error" });
  });

  it("is invalid with schema issues, and keeps the version it read", () => {
    const check = checkLibraryFile(
      FORMAT_REGISTRY,
      "library",
      "library.json",
      bytes(JSON.stringify({ ...library, name: 3 })),
    );
    expect(check).toMatchObject({ status: "invalid", formatVersion: 1, value: null });
    expect(check.issues).toMatchObject([{ code: "schema-violation", pointer: "/name" }]);
  });

  it("reports newer-format and nothing else for a version above the supported one", () => {
    const check = checkLibraryFile(
      FORMAT_REGISTRY,
      "library",
      "library.json",
      bytes(JSON.stringify({ formatVersion: 2, x: 1 })),
    );
    expect(check).toMatchObject({ status: "newer", formatVersion: 2, value: null });
    expect(check.issues).toHaveLength(1);
    expect(check.issues[0]).toMatchObject({
      code: "newer-format",
      severity: "error",
      file: "library.json",
      pointer: "/formatVersion",
    });
  });

  it.each([[0], [1.5], [-1], ["1"], [null], [2 ** 60]])(
    "checks formatVersion %j against the current schema, which reports it",
    (version) => {
      const check = checkLibraryFile(
        FORMAT_REGISTRY,
        "library",
        "library.json",
        bytes(JSON.stringify({ ...library, formatVersion: version })),
      );
      // 2 ** 60 is not a safe integer (format-spec §3.2), so it is no version either.
      expect(check.status).toBe("invalid");
      expect(check.formatVersion).toBeNull();
      expect(check.issues).toMatchObject([{ code: "schema-violation", pointer: "/formatVersion" }]);
    },
  );

  it("never lets a file name with control characters into a message unescaped", () => {
    const check = checkLibraryFile(
      FORMAT_REGISTRY,
      "family",
      "families/a\u001b[31m‮b.json",
      bytes(JSON.stringify({ slug: "quiet" })),
    );
    const mismatch = check.issues.find((i) => i.code === "name-mismatch");
    expect(mismatch?.message).toMatch(/^[\x20-\x7e]+$/);
  });
});
