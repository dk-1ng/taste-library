import { describe, expect, it } from "vitest";
import { v1Shared } from "../browser.js";
import {
  newGuardrailId,
  newLibraryId,
  newRefId,
  newStatementId,
  newTermId,
  randomPart,
} from "./random.js";
import { issueNext } from "./sequence.js";
import { deriveSlug, makeSlug, shortenSlug } from "./slug.js";

const fixed = (values: number[]) => {
  let i = 0;
  return (bytes: Uint8Array) => {
    for (let k = 0; k < bytes.length; k++) bytes[k] = values[i++ % values.length] ?? 0;
  };
};

describe("random identifiers", () => {
  it("match the patterns of format-spec §4.3", () => {
    const now = () => new Date("2026-11-04T23:59:59Z");
    for (let i = 0; i < 200; i++) {
      expect(v1Shared.LibraryId.safeParse(newLibraryId()).success).toBe(true);
      expect(v1Shared.RefId.safeParse(newRefId({ now })).success).toBe(true);
      expect(v1Shared.GuardrailId.safeParse(newGuardrailId()).success).toBe(true);
      expect(v1Shared.TermId.safeParse(newTermId()).success).toBe(true);
      expect(v1Shared.StatementId.safeParse(newStatementId()).success).toBe(true);
    }
    expect(newRefId({ now })).toMatch(/^ref-20261104-/);
  });

  it("uses the UTC date, not the local one", () => {
    const now = () => new Date("2026-01-01T00:30:00+05:00");
    expect(newRefId({ now })).toMatch(/^ref-20251231-/);
  });

  it("has no bias: every byte value maps to a symbol, 8 byte values to each", () => {
    const all = Uint8Array.from({ length: 256 }, (_, i) => i);
    const out = randomPart(256, (b) => b.set(all));
    const counts = new Map<string, number>();
    for (const c of out) counts.set(c, (counts.get(c) ?? 0) + 1);
    expect(counts.size).toBe(32);
    expect([...counts.values()].every((n) => n === 8)).toBe(true);
    expect(out).not.toMatch(/[ilou]/);
  });

  it("draws again when the id exists", () => {
    const taken = new Set([`gr-${randomPart(6, fixed([0]))}`]);
    const random = fixed([0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1]);
    expect(newGuardrailId({ exists: (id) => taken.has(id), random })).toBe("gr-111111");
  });

  it("gives up when nothing is free", () => {
    expect(() => newTermId({ exists: () => true })).toThrow();
  });
});

describe("sequential identifiers", () => {
  it("issues lastIssued + 1", () => {
    expect(issueNext("p", 0)).toEqual({ id: "p1", lastIssued: 1 });
    expect(issueNext("d", 7)).toEqual({ id: "d8", lastIssued: 8 });
  });

  it("never gives a deleted number again", () => {
    let last = 0;
    for (let i = 0; i < 3; i++) last = issueNext("p", last).lastIssued;
    // p3 is deleted; lastIssued stays 3.
    expect(issueNext("p", last).id).toBe("p4");
  });

  it("refuses a bad counter and the end of the safe range", () => {
    expect(() => issueNext("m", -1)).toThrow();
    expect(() => issueNext("m", 1.5)).toThrow();
    expect(() => issueNext("m", Number.MAX_SAFE_INTEGER)).toThrow();
  });
});

describe("slugs", () => {
  it("derives, dropping accents", () => {
    expect(deriveSlug("Ação")).toBe("acao");
    expect(deriveSlug("  Quiet -- Editorial!  ")).toBe("quiet-editorial");
    expect(makeSlug("Ação", "family")).toBe("acao");
  });

  it("falls back to a random slug for another script", () => {
    const slug = makeSlug("日本", "project", { random: fixed([0]) });
    expect(slug).toBe("project-000000");
    expect(v1Shared.Slug.safeParse(slug).success).toBe(true);
  });

  it("shortens a long name at the last hyphen, or at the limit", () => {
    const long = Array.from({ length: 30 }, () => "word").join(" ");
    const slug = makeSlug(long, "family");
    expect(slug.length).toBeLessThanOrEqual(64);
    expect(slug.endsWith("-")).toBe(false);
    expect(slug).toBe(Array.from({ length: 13 }, () => "word").join("-"));
    expect(makeSlug("a".repeat(100), "family")).toBe("a".repeat(64));
    expect(shortenSlug(`${"a".repeat(64)}-b`)).toBe("a".repeat(64));
  });

  it("replaces a reserved word, also one that shortening produces", () => {
    expect(makeSlug("CON", "family", { random: fixed([1]) })).toBe("family-111111");
    expect(makeSlug("com1", "project", { random: fixed([2]) })).toBe("project-222222");
    expect(makeSlug(`con ${"x".repeat(70)}`, "family", { random: fixed([3]) })).toBe(
      "family-333333",
    );
  });

  it("appends -2, -3 to a taken slug", () => {
    const taken = new Set(["quiet", "quiet-2"]);
    expect(makeSlug("Quiet", "family", { isTaken: (s) => taken.has(s) })).toBe("quiet-3");
  });

  it("shortens the base so the suffix fits near 64 characters", () => {
    const base = "a".repeat(64);
    const taken = new Set([base, `${"a".repeat(62)}-2`]);
    const slug = makeSlug(base, "family", { isTaken: (s) => taken.has(s) });
    expect(slug).toBe(`${"a".repeat(62)}-3`);
    expect(slug.length).toBe(64);
    const words = `${"a".repeat(30)}-${"b".repeat(33)}`;
    const next = makeSlug(words, "family", { isTaken: (s) => s === words });
    expect(next).toBe(`${"a".repeat(30)}-2`);
    expect(v1Shared.Slug.safeParse(next).success).toBe(true);
  });
});
