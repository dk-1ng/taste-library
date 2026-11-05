import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { issuesFromZod } from "../../validation/zod-issues.js";
import {
  AgentLabel,
  authored,
  DirectionId,
  GuardrailId,
  HttpUrl,
  LanguageTag,
  LibraryId,
  line,
  LocalPieceId,
  MediaId,
  Name,
  Note,
  PieceRef,
  PinId,
  RefId,
  reviewedLink,
  Sha256,
  Slug,
  StatementId,
  Tag,
  TagList,
  TermId,
  text,
  Timestamp,
} from "./shared.js";

function problems(schema: z.ZodType, value: unknown) {
  const result = schema.safeParse(value, { reportInput: true });
  return result.success
    ? []
    : issuesFromZod(result.error, "f.json").map((i) => `${i.code} ${i.pointer}`);
}
const ok = (schema: z.ZodType, value: unknown) => expect(problems(schema, value)).toEqual([]);
const bad = (schema: z.ZodType, value: unknown) =>
  expect(problems(schema, value)).toEqual(["schema-violation null"]);

const SHA = "a".repeat(64);
const T0 = "2026-11-04T12:00:00.000Z";

describe("Timestamp", () => {
  it("accepts UTC milliseconds", () => {
    ok(Timestamp, T0);
    ok(Timestamp, "2024-02-29T00:00:00.000Z");
  });
  it("rejects other shapes, offsets and dates that do not exist", () => {
    for (const value of [
      "2026-11-04T12:00:00Z",
      "2026-11-04T12:00:00.000+00:00",
      "2026-11-04 12:00:00.000Z",
      "2026-02-30T00:00:00.000Z",
      "2025-02-29T00:00:00.000Z",
      "2026-13-01T00:00:00.000Z",
      "2026-11-04T24:00:00.000Z",
      5,
      null,
    ]) {
      expect(problems(Timestamp, value), String(value)).not.toEqual([]);
    }
  });
});

describe("text types, counted in code points", () => {
  it("Line: 1 to Max code points, no control characters", () => {
    ok(line(3), "abc");
    ok(line(2), "😀😀");
    ok(line(10), "Usuário 日本");
    bad(line(2), "😀😀😀");
    bad(line(3), "");
    bad(line(10), "a\nb");
    bad(line(10), "a\tb");
    bad(line(10), "a\u0085b");
    bad(line(10), "a\u007fb");
  });
  it("Text: line breaks and tabs allowed, other controls not", () => {
    ok(text(1, 10), "a\nb\tc");
    ok(text(0, 10), "");
    bad(text(1, 10), "");
    bad(text(0, 10), "a\rb");
    bad(text(0, 10), "a\u0000b");
    bad(text(0, 3), "abcd");
  });
  it("Name and Note limits", () => {
    ok(Name, "é".repeat(200));
    bad(Name, "é".repeat(201));
    ok(Note, "");
    ok(Note, "あ".repeat(100000));
    bad(Note, "あ".repeat(100001));
  });
  it("Tag: 1 to 64, one line, no edge whitespace", () => {
    ok(Tag, "quiet density");
    ok(Tag, "x".repeat(64));
    bad(Tag, "x".repeat(65));
    bad(Tag, "");
    bad(Tag, " lead");
    bad(Tag, "trail ");
    bad(Tag, "a\nb");
  });
  it("TagList: at most 50, unique by NFC and lowercase", () => {
    ok(TagList, []);
    ok(TagList, ["calm", "dense"]);
    expect(problems(TagList, ["Calm", "calm"])).toEqual(["schema-violation /1"]);
    expect(problems(TagList, ["é", "é"])).toEqual(["schema-violation /1"]);
    expect(problems(TagList, ["İ", "i̇"])).toEqual(["schema-violation /1"]);
    expect(
      problems(
        TagList,
        Array.from({ length: 51 }, (_, i) => `t${i}`),
      ),
    ).toEqual(["schema-violation null"]);
    ok(
      TagList,
      Array.from({ length: 50 }, (_, i) => `t${i}`),
    );
  });
});

describe("identifiers", () => {
  it("accept the documented forms", () => {
    ok(LibraryId, "lib-7d2k9q4m1x");
    ok(RefId, "ref-20261104-k3x9ab");
    ok(RefId, "ref-20240229-k3x9ab");
    ok(GuardrailId, "gr-4m8q2z");
    ok(TermId, "term-9x2b7c");
    ok(StatementId, "st-1h6v3r");
    ok(MediaId, "m1");
    ok(PinId, "p3");
    ok(LocalPieceId, "p0");
    ok(LocalPieceId, "p12");
    ok(DirectionId, "d2");
  });
  it("refuse wrong forms, letters outside the alphabet and leading zeros", () => {
    for (const [schema, value] of [
      [LibraryId, "lib-7d2k9q4m1"],
      [LibraryId, "lib-7d2k9q4m1u"],
      [LibraryId, "lib-7D2K9Q4M1X"],
      [RefId, "ref-20261104-k3x9al"],
      [RefId, "ref-2026114-k3x9ab"],
      [GuardrailId, "gr-4m8q2o"],
      [TermId, "term-9x2b7"],
      [StatementId, "st-1h6v3ri"],
      [MediaId, "m0"],
      [MediaId, "m01"],
      [PinId, "p0"],
      [PinId, "p01"],
      [LocalPieceId, "p00"],
      [LocalPieceId, "p-1"],
      [DirectionId, "d0"],
    ] as const) {
      bad(schema, value);
    }
  });
  it("RefId needs a date that exists", () => {
    bad(RefId, "ref-20261301-k3x9ab");
    bad(RefId, "ref-20260230-k3x9ab");
    bad(RefId, "ref-20250229-k3x9ab");
    bad(RefId, "ref-19000229-k3x9ab");
    ok(RefId, "ref-20000229-k3x9ab");
    bad(RefId, "ref-20260100-k3x9ab");
  });
  it("PieceRef joins a RefId and a piece id", () => {
    ok(PieceRef, "ref-20261104-k3x9ab#p0");
    ok(PieceRef, "ref-20261104-k3x9ab#p2");
    bad(PieceRef, "ref-20261104-k3x9ab#p");
    bad(PieceRef, "ref-20261104-k3x9ab#p01");
    bad(PieceRef, "ref-20261104-k3x9ab");
    bad(PieceRef, "ref-20261104-k3x9ab#m1");
    bad(PieceRef, "ref-20260230-k3x9ab#p1");
  });
  it("Slug: pattern, 64 characters, no Windows reserved names", () => {
    ok(Slug, "quiet-editorial");
    ok(Slug, "a");
    ok(Slug, "a".repeat(64));
    ok(Slug, "console");
    ok(Slug, "com10");
    bad(Slug, "a".repeat(65));
    bad(Slug, "");
    bad(Slug, "Quiet");
    bad(Slug, "-a");
    bad(Slug, "a-");
    bad(Slug, "a--b");
    bad(Slug, "a_b");
    bad(Slug, "á");
    for (const name of ["con", "prn", "aux", "nul", "com1", "com9", "lpt1", "lpt9"])
      bad(Slug, name);
  });
  it("AgentLabel", () => {
    ok(AgentLabel, "claude-code");
    ok(AgentLabel, "a.b_c-1");
    bad(AgentLabel, "-x");
    bad(AgentLabel, "X");
    bad(AgentLabel, "a".repeat(65));
  });
});

describe("Sha256, HttpUrl, LanguageTag", () => {
  it("Sha256 is 64 lowercase hex characters", () => {
    ok(Sha256, SHA);
    bad(Sha256, "A".repeat(64));
    bad(Sha256, "a".repeat(63));
    bad(Sha256, `${"a".repeat(63)}g`);
  });
  it("HttpUrl: http or https, normalized, no credentials, at most 2048", () => {
    ok(HttpUrl, "https://example.com/");
    ok(HttpUrl, "http://example.com/a?b=c#d");
    ok(HttpUrl, "https://xn--exemplo-9ua.com/%C3%A1");
    bad(HttpUrl, "https://example.com");
    bad(HttpUrl, "HTTPS://example.com/");
    bad(HttpUrl, "https://exämple.com/");
    bad(HttpUrl, "ftp://example.com/");
    bad(HttpUrl, "javascript:alert(1)");
    bad(HttpUrl, "/relative");
    bad(HttpUrl, "https://user@example.com/");
    bad(HttpUrl, "https://user:pw@example.com/");
    bad(HttpUrl, `https://example.com/${"a".repeat(2048)}`);
    ok(HttpUrl, `https://example.com/${"a".repeat(2048 - 20)}`);
  });
  it("LanguageTag", () => {
    for (const value of ["en", "pt-BR", "zh-Hant", "zh-Hant-TW", "es-419", "fil"])
      ok(LanguageTag, value);
    for (const value of ["EN", "e", "pt_BR", "pt-br", "en-US-x", "english"])
      bad(LanguageTag, value);
  });
});

describe("Authored", () => {
  const content = line(20);
  const schema = (inputSha256: "required" | "null" = "null") => authored(content, { inputSha256 });
  const user = { origin: "user", content: "hello", writtenAt: T0 };
  const agent = {
    origin: "agent",
    proposedBy: "claude-code",
    proposedAt: T0,
    inputSha256: null,
    proposal: "idea",
    status: "to-review",
    correction: null,
    reviewedAt: null,
  };
  const withAgent = (patch: Record<string, unknown>) => ({ ...agent, ...patch });

  it("accepts the user form and every consistent agent form", () => {
    ok(schema(), user);
    ok(schema(), agent);
    ok(schema(), withAgent({ status: "accepted", reviewedAt: T0 }));
    ok(schema(), withAgent({ status: "rejected", reviewedAt: "2026-11-05T00:00:00.000Z" }));
    ok(schema(), withAgent({ status: "corrected", correction: "mine", reviewedAt: T0 }));
  });
  it("refuses a correction unless corrected, and corrected without one", () => {
    expect(problems(schema(), withAgent({ correction: "mine" }))).toEqual([
      "schema-violation /correction",
    ]);
    expect(
      problems(schema(), withAgent({ status: "accepted", reviewedAt: T0, correction: "x" })),
    ).toEqual(["schema-violation /correction"]);
    expect(problems(schema(), withAgent({ status: "corrected", reviewedAt: T0 }))).toEqual([
      "schema-violation /correction",
    ]);
  });
  it("refuses reviewedAt that disagrees with the status or precedes proposedAt", () => {
    expect(problems(schema(), withAgent({ reviewedAt: T0 }))).toEqual([
      "schema-violation /reviewedAt",
    ]);
    expect(problems(schema(), withAgent({ status: "accepted" }))).toEqual([
      "schema-violation /reviewedAt",
    ]);
    expect(
      problems(schema(), withAgent({ status: "accepted", reviewedAt: "2026-11-04T11:59:59.999Z" })),
    ).toEqual(["schema-violation /reviewedAt"]);
  });
  it("inputSha256 is required in a piece interpretation and null elsewhere", () => {
    expect(problems(schema("required"), agent)).toEqual(["schema-violation /inputSha256"]);
    ok(schema("required"), withAgent({ inputSha256: SHA }));
    expect(problems(schema("null"), withAgent({ inputSha256: SHA }))).toEqual([
      "schema-violation /inputSha256",
    ]);
  });
  it("refuses unknown fields, a missing field and a wrong origin", () => {
    expect(problems(schema(), { ...user, extra: 1 })).toEqual(["schema-violation /extra"]);
    const { writtenAt: _omit, ...missing } = user;
    expect(problems(schema(), missing)).toEqual(["schema-violation /writtenAt"]);
    const { correction: _c, ...noCorrection } = agent;
    expect(problems(schema(), noCorrection)).toEqual(["schema-violation /correction"]);
    expect(problems(schema(), { ...user, origin: "robot" })).toEqual(["schema-violation /origin"]);
    expect(problems(schema(), {})).toEqual(["schema-violation /origin"]);
  });
  it("keeps non-ASCII content", () => {
    ok(schema(), { ...user, content: "ação 日本" });
  });
});

describe("ReviewedLink", () => {
  const schema = reviewedLink(PieceRef);
  const target = "ref-20261104-k3x9ab#p1";
  const agent = {
    target,
    origin: "agent",
    proposedBy: "claude-code",
    proposedAt: T0,
    status: "to-review",
    reviewedAt: null,
  };
  it("accepts user links and consistent agent links", () => {
    ok(schema, { target, origin: "user", addedAt: T0 });
    ok(schema, agent);
    ok(schema, { ...agent, status: "accepted", reviewedAt: T0 });
    ok(schema, { ...agent, status: "rejected", reviewedAt: T0 });
  });
  it("refuses the corrected status, bad targets and inconsistent reviews", () => {
    expect(problems(schema, { ...agent, status: "corrected", reviewedAt: T0 })).toEqual([
      "schema-violation /status",
    ]);
    expect(problems(schema, { ...agent, target: "nope" })).toEqual(["schema-violation /target"]);
    expect(problems(schema, { ...agent, reviewedAt: T0 })).toEqual([
      "schema-violation /reviewedAt",
    ]);
    expect(problems(schema, { ...agent, status: "accepted" })).toEqual([
      "schema-violation /reviewedAt",
    ]);
    expect(
      problems(schema, { ...agent, status: "accepted", reviewedAt: "2026-01-01T00:00:00.000Z" }),
    ).toEqual(["schema-violation /reviewedAt"]);
  });
});
