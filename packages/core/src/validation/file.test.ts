import { withTempDir } from "@tastelib/testkit";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { generateLibrary } from "../../test/support/generate.js";
import { GOLDEN_V1 } from "../../test/support/golden.js";
import { TEST_REGISTRY } from "../../test/support/registry.js";
import { type FileKind, FORMAT_REGISTRY, type FormatRegistry } from "../format.js";
import { isFileType, serialize } from "../json/canonical.js";
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
          canonicalize: v1.canonicalize,
          serialize: v1.serialize,
        },
      },
      steps: {},
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

describe("a file at a path its own version does not have (format-spec §15.2)", () => {
  const term = {
    id: "term-2b4d6f",
    createdAt: "2026-11-02T12:00:00.000Z",
    updatedAt: "2026-11-02T12:00:00.000Z",
    pieces: [],
    entry: {
      origin: "user",
      content: { term: "Quiet density", definition: "Much information, little noise." },
      writtenAt: "2026-11-02T12:00:00.000Z",
    },
  };
  const violation = (file: string, formatVersion: number | null) => ({
    status: "invalid",
    formatVersion,
    value: null,
    issues: [
      {
        severity: "error",
        code: "schema-violation",
        file,
        pointer: "/formatVersion",
        message: expect.stringMatching(/^formatVersion: /),
      },
    ],
  });

  it("is a schema-violation at /formatVersion for a file of a version that has no such path", () => {
    // `glossary/<term-id>.json` is a file of the test-only version 2, never of version 1.
    const path = "glossary/term-2b4d6f.json";
    expect(
      checkLibraryFile(
        TEST_REGISTRY,
        "glossary-term",
        path,
        bytes(JSON.stringify({ formatVersion: 1, ...term })),
      ),
    ).toEqual(violation(path, 1));
    // The same file at version 2 is valid.
    expect(
      checkLibraryFile(
        TEST_REGISTRY,
        "glossary-term",
        path,
        bytes(JSON.stringify({ formatVersion: 2, ...term })),
      ),
    ).toMatchObject({ status: "valid", formatVersion: 2 });
  });

  it("is a schema-violation at /formatVersion for a file a later version removed", () => {
    // Version 2 split `glossary.json` into one file per term.
    const glossary = bytes(JSON.stringify({ formatVersion: 2, terms: [term] }));
    expect(checkLibraryFile(TEST_REGISTRY, "glossary", "glossary.json", glossary)).toEqual(
      violation("glossary.json", 2),
    );
    // Without a valid version, the file is checked against the current version, which has no such path.
    const unknown = bytes(JSON.stringify({ formatVersion: "one", terms: [term] }));
    expect(checkLibraryFile(TEST_REGISTRY, "glossary", "glossary.json", unknown)).toEqual(
      violation("glossary.json", null),
    );
  });

  it("follows the path, not the kind: a kind both versions have, at a path only one of them has", () => {
    // A version 2 that keeps the family kind but moves its folder from families/ to collections/.
    const v1 = TEST_REGISTRY.versions[1];
    const v2 = TEST_REGISTRY.versions[2];
    if (v1 === undefined || v2 === undefined) throw new Error("no versions 1 and 2");
    const { families: _families, ...flat } = v2.layout.flatFolders;
    const moved: FormatRegistry = {
      ...TEST_REGISTRY,
      versions: {
        1: v1,
        2: { ...v2, layout: { ...v2.layout, flatFolders: { ...flat, collections: "family" } } },
      },
    };
    const family = (formatVersion: number) =>
      bytes(
        JSON.stringify({
          formatVersion,
          slug: "calm",
          createdAt: "2026-11-02T09:00:00.000Z",
          updatedAt: "2026-11-02T09:00:00.000Z",
          description: {
            origin: "user",
            content: { name: "Calm", meaning: "Quiet layouts.", vocabulary: [] },
            writtenAt: "2026-11-02T09:00:00.000Z",
          },
          members: [],
        }),
      );
    // Each version's schemas have the family kind, so only the path tells which one applies.
    expect(checkLibraryFile(moved, "family", "collections/calm.json", family(1))).toEqual(
      violation("collections/calm.json", 1),
    );
    expect(checkLibraryFile(moved, "family", "families/calm.json", family(2))).toEqual(
      violation("families/calm.json", 2),
    );
    expect(checkLibraryFile(moved, "family", "families/calm.json", family(1))).toMatchObject({
      status: "valid",
      formatVersion: 1,
    });
    expect(checkLibraryFile(moved, "family", "collections/calm.json", family(2))).toMatchObject({
      status: "valid",
      formatVersion: 2,
    });
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
  function byteVerdict(kind: FileKind, value: unknown, given: Uint8Array): boolean {
    if (!isFileType(kind)) throw new Error(`${kind} is not a kind of version 1`);
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
