import { withTempDir } from "@tastelib/testkit";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { generateLibrary } from "../../test/support/generate.js";
import { GOLDEN_V1 } from "../../test/support/golden.js";
import { FORMAT_REGISTRY, type FormatRegistry, type LibraryFileKind } from "../format.js";
import { serialize } from "../json/canonical.js";
import { openLibrary } from "../node/open.js";
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

  it("compares the name and the value after NFC, so a folder in another Unicode form is no mismatch", () => {
    // Real slugs are ASCII, so the project schema is relaxed here to let the comparison itself run.
    const v1 = FORMAT_REGISTRY.versions[1];
    if (v1 === undefined) throw new Error("no version 1");
    const relaxed: FormatRegistry = {
      current: 1,
      versions: {
        1: {
          schemas: {
            ...v1.schemas,
            project: z.looseObject({ formatVersion: z.literal(1), slug: z.string() }),
          },
          layout: v1.layout,
        },
      },
    };
    const slug = "caf\u00e9"; // precomposed, as typed
    const path = `projects/${slug.normalize("NFD")}/project.json`; // as macOS may list it
    const same = checkLibraryFile(
      relaxed,
      "project",
      path,
      bytes(JSON.stringify({ formatVersion: 1, slug })),
    );
    expect(same.issues).toEqual([]);
    const other = checkLibraryFile(
      relaxed,
      "project",
      path,
      bytes(JSON.stringify({ formatVersion: 1, slug: "cafe" })),
    );
    expect(other.issues).toMatchObject([{ code: "name-mismatch", pointer: "/slug" }]);
  });
});

describe("a file whose whole content is null", () => {
  it.each([
    ["references/ref-20261101-a1b2c3.json", "reference"],
    ["families/quiet-editorial.json", "family"],
    ["projects/landing-redesign/project.json", "project"],
  ] as const)("%s is a schema violation, not a crash", (path, kind) => {
    const check = checkLibraryFile(FORMAT_REGISTRY, kind, path, new TextEncoder().encode("null"));
    expect(check.status).toBe("invalid");
    expect(check.issues.map((issue) => issue.code)).toContain("schema-violation");
  });
});

describe("the canonical check gives the verdict of a byte comparison with serialize", () => {
  type Loose = Record<string, unknown>;
  const decoder = new TextDecoder();

  /** The verdict by its definition (format-spec §3.3): the bytes equal `serialize` of the value. */
  function byteVerdict(kind: LibraryFileKind, value: unknown, given: Uint8Array): boolean {
    const expected = bytes(serialize(kind, value));
    return expected.length === given.length && expected.every((byte, i) => byte === given[i]);
  }

  /** Every key order reversed, deeply. */
  function reverseKeys(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(reverseKeys);
    if (typeof value !== "object" || value === null) return value;
    return Object.fromEntries(
      Object.entries(value as Loose)
        .reverse()
        .map(([key, item]) => [key, reverseKeys(item)]),
    );
  }

  /** Every list reversed, deeply (some lists must be sorted, so this may not be canonical). */
  function reverseLists(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(reverseLists).reverse();
    if (typeof value !== "object" || value === null) return value;
    return Object.fromEntries(
      Object.entries(value as Loose).map(([key, item]) => [key, reverseLists(item)]),
    );
  }

  /** The file and variants of it: BOM, CRLF, reordered, compact, escaped, `1.0`, no final LF. */
  function variants(original: Uint8Array): Uint8Array[] {
    const text = decoder.decode(original);
    const value: unknown = JSON.parse(text);
    const escapeOne = text.replace(
      /[\u0080-\uffff]/,
      (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
    );
    return [
      original,
      bytes(`﻿${text}`),
      bytes(text.replaceAll("\n", "\r\n")),
      bytes(`﻿${text.replaceAll("\n", "\r\n")}`),
      bytes(`${JSON.stringify(reverseKeys(value), null, 2)}\n`),
      bytes(`${JSON.stringify(reverseLists(value), null, 2)}\n`),
      bytes(`${JSON.stringify(value)}\n`),
      bytes(text.trimEnd()),
      bytes(text.replace('"formatVersion": 1,', '"formatVersion": 1.0,')),
      bytes(escapeOne),
    ];
  }

  async function compareOn(root: string): Promise<{ canonical: number; notCanonical: number }> {
    const opened = await openLibrary(root);
    if (!opened.ok) throw new Error(opened.message);
    const result = await opened.library.snapshot();
    if (!result.ok) throw new Error(result.message);
    let canonical = 0;
    let notCanonical = 0;
    for (const file of result.snapshot.files.values()) {
      if (file.bytes === null) throw new Error(`${file.path} could not be read`);
      for (const variant of variants(file.bytes)) {
        const check = checkLibraryFile(FORMAT_REGISTRY, file.kind, file.path, variant);
        if (check.status !== "valid") continue;
        const flagged = check.issues.some((issue) => issue.code === "not-canonical");
        const expected = !byteVerdict(file.kind, check.value, variant);
        expect(flagged, `${file.path}: ${JSON.stringify(decoder.decode(variant))}`).toBe(expected);
        if (expected) notCanonical++;
        else canonical++;
      }
    }
    return { canonical, notCanonical };
  }

  it("on the golden library and its variants", async () => {
    const counts = await compareOn(GOLDEN_V1);
    expect(counts.canonical).toBeGreaterThan(5);
    expect(counts.notCanonical).toBeGreaterThan(50);
  });

  it("on a generated library and its variants", async () => {
    await withTempDir(async (root) => {
      await generateLibrary(root, {
        references: 60,
        families: 4,
        membersPerFamily: 10,
        terms: 20,
        seed: 7,
      });
      const counts = await compareOn(root);
      expect(counts.canonical).toBeGreaterThan(60);
      expect(counts.notCanonical).toBeGreaterThan(400);
    });
  });
});
