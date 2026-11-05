import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { issuesFromZod } from "../../validation/zod-issues.js";
import { LibrarySchema } from "./library.js";
import { MediaMarkerSchema } from "./marker.js";

function check(schema: z.ZodType, value: unknown) {
  const result = schema.safeParse(value, { reportInput: true });
  return result.success ? [] : issuesFromZod(result.error, "library.json");
}

const library = {
  formatVersion: 1,
  id: "lib-7d2k9q4m1x",
  name: "Interfaces I keep coming back to",
  language: "en",
  createdAt: "2026-11-04T12:00:00.000Z",
};

describe("library.json", () => {
  it("accepts the example of format-spec §5.1 and non-ASCII names", () => {
    expect(check(LibrarySchema, library)).toEqual([]);
    expect(
      check(LibrarySchema, {
        ...library,
        name: "Interfaces que eu sempre revisito: ação, 日本",
        language: "pt-BR",
      }),
    ).toEqual([]);
  });

  it("keeps the name as written", () => {
    const parsed = LibrarySchema.parse({ ...library, name: "  spaced  name " });
    expect(parsed.name).toBe("  spaced  name ");
  });

  it("refuses every broken rule with a pointer and a message that names the field", () => {
    const cases: [Record<string, unknown>, string, string][] = [
      [{ formatVersion: 2 }, "/formatVersion", "formatVersion: must be 1."],
      [{ id: "lib-short" }, "/id", "id: must be a library id"],
      [{ name: "" }, "/name", "name: must be 1 to 200 characters long."],
      [{ name: "a\nb" }, "/name", "name: must be a single line"],
      [{ language: "pt_BR" }, "/language", "language: must be a language tag"],
      [
        { createdAt: "2026-02-30T00:00:00.000Z" },
        "/createdAt",
        "createdAt: must be a date and time that exist.",
      ],
    ];
    for (const [patch, pointer, message] of cases) {
      const issues = check(LibrarySchema, { ...library, ...patch });
      expect(issues).toHaveLength(1);
      expect(issues[0]).toMatchObject({
        severity: "error",
        code: "schema-violation",
        file: "library.json",
        pointer,
      });
      expect(issues[0]?.message.startsWith(message), issues[0]?.message).toBe(true);
    }
  });

  it("refuses an unknown field and a missing field", () => {
    const unknown = check(LibrarySchema, { ...library, extra: 1 });
    expect(unknown).toMatchObject([{ code: "schema-violation", pointer: "/extra" }]);
    expect(unknown[0]?.message).toBe("extra: is not a field of this file.");
    const { language: _language, ...missing } = library;
    const issues = check(LibrarySchema, missing);
    expect(issues).toMatchObject([
      { code: "schema-violation", pointer: "/language", message: "language: is required." },
    ]);
  });

  it("refuses a value that is not an object", () => {
    expect(check(LibrarySchema, [])).toMatchObject([{ code: "schema-violation", pointer: null }]);
    expect(check(LibrarySchema, null)).toMatchObject([{ code: "schema-violation", pointer: null }]);
  });
});

describe("media marker", () => {
  const marker = { formatVersion: 1, libraryId: "lib-7d2k9q4m1x" };
  it("accepts the marker", () => {
    expect(check(MediaMarkerSchema, marker)).toEqual([]);
  });
  it("refuses a bad library id, an unknown field and a missing field", () => {
    expect(check(MediaMarkerSchema, { ...marker, libraryId: "x" })).toMatchObject([
      { pointer: "/libraryId" },
    ]);
    expect(check(MediaMarkerSchema, { ...marker, extra: true })).toMatchObject([
      { pointer: "/extra" },
    ]);
    expect(check(MediaMarkerSchema, { formatVersion: 1 })).toMatchObject([
      { pointer: "/libraryId", message: "libraryId: is required." },
    ]);
    expect(check(MediaMarkerSchema, { ...marker, formatVersion: 2 })).toMatchObject([
      { pointer: "/formatVersion" },
    ]);
  });
});
