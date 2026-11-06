import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { roundAxis, roundRegion } from "../model/region.js";
import { ReferenceSchema } from "../schemas/v1/reference.js";
import { canonicalIssue, canonicalize, isCanonical, serialize } from "./canonical.js";
import { readLibraryJson } from "./read.js";

const enc = (text: string): Uint8Array => new TextEncoder().encode(text);

// biome-ignore lint/suspicious/noExplicitAny: the fixtures are plain JSON that tests mutate by path.
type Loose = any;

/** The example of format-spec §7.8, read from the specification so the two cannot drift apart. */
function specExample(): string {
  const spec = readFileSync(new URL("../../../../docs/format-spec.md", import.meta.url), "utf8");
  const section = spec.slice(spec.indexOf("### 7.8 Example"));
  const match = /```json\n([\s\S]*?)\n```/.exec(section);
  if (!match?.[1]) throw new Error("the §7.8 example was not found");
  return `${match[1]}\n`;
}

const T1 = "2026-11-04T12:00:00.000Z";
const T2 = "2026-11-04T12:05:00.000Z";
const SHA = "a".repeat(64);
const REF = "ref-20261104-k3x9ab";
const userValue = (content: unknown) => ({ origin: "user", content, writtenAt: T1 });

/** Reverses every object's keys and every list of objects, a hostile input order. */
function scramble(value: unknown): unknown {
  if (Array.isArray(value)) {
    const items = value.map(scramble);
    return items.some((item) => typeof item === "object" && item !== null)
      ? items.reverse()
      : items;
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .map(([key, item]) => [key, scramble(item)] as const)
        .reverse(),
    );
  }
  return value;
}

describe("serialize: the specification's example", () => {
  it("gives exactly the bytes shown in §7.8, plus the final LF", () => {
    const text = specExample();
    const read = readLibraryJson(enc(text), "r.json");
    if (!read.ok) throw new Error("the example must read");
    expect(serialize("reference", read.value)).toBe(text);
    expect(isCanonical("reference", read.value, enc(text))).toBe(true);
  });
});

function reference(): Loose {
  const media = (n: number) => ({
    id: `m${n}`,
    kind: "image",
    file: `${REF}/m${n}.webp`,
    type: "image/webp",
    bytes: 10,
    sha256: SHA,
    width: 100,
    height: 100,
    durationMs: null,
    frames: [],
  });
  const pin = (n: number) => ({
    id: `p${n}`,
    mediaId: "m1",
    frameMs: null,
    region: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 },
    polarity: "positive",
    note: `n${n}`,
    createdAt: T1,
  });
  const interpretation = {
    summary: "s",
    vocabulary: ["b", "a"],
    keywords: [],
    screenTypes: [],
    components: [],
    aspects: [],
  };
  return {
    formatVersion: 1,
    id: REF,
    createdAt: T1,
    updatedAt: T2,
    source: { via: "paste", url: null },
    result: null,
    media: [media(1), media(2), media(10)],
    note: "Usuário 😀",
    pins: [pin(1), pin(2), pin(10)],
    interpretations: {
      p0: userValue(interpretation),
      p1: userValue(interpretation),
      p2: userValue(interpretation),
      p10: userValue(interpretation),
    },
    lastIssued: { media: 10, pin: 10 },
  };
}

function video(): Loose {
  const value = reference();
  const frame = (timeMs: number) => ({
    timeMs,
    file: `${REF}/m1-t${timeMs}.png`,
    type: "image/png",
    bytes: 5,
    sha256: SHA,
    width: 10,
    height: 10,
  });
  value.media = [
    {
      ...value.media[0],
      kind: "video",
      file: `${REF}/m1.mp4`,
      type: "video/mp4",
      durationMs: 5000,
      frames: [frame(0), frame(100), frame(2000)],
    },
  ];
  value.pins = [];
  value.interpretations = {};
  value.lastIssued = { media: 1, pin: 0 };
  return value;
}

describe("serialize: layout", () => {
  it("is two-space JSON, ends with one LF, has no BOM and keeps non-ASCII text", () => {
    const text = serialize("reference", reference());
    expect(text.endsWith("}\n")).toBe(true);
    expect(text.endsWith("\n\n")).toBe(false);
    expect(text.charCodeAt(0)).toBe(0x7b);
    expect(text).not.toContain("\r");
    expect(text).toContain('  "formatVersion": 1,');
    expect(text).toContain("Usuário 😀");
    expect(text).not.toContain("\\u");
  });

  it("orders keys as the specification lists them", () => {
    const parsed = JSON.parse(serialize("reference", scramble(reference())));
    expect(Object.keys(parsed)).toEqual([
      "formatVersion",
      "id",
      "createdAt",
      "updatedAt",
      "source",
      "result",
      "media",
      "note",
      "pins",
      "interpretations",
      "lastIssued",
    ]);
    expect(Object.keys(parsed.pins[0])).toEqual([
      "id",
      "mediaId",
      "frameMs",
      "region",
      "polarity",
      "note",
      "createdAt",
    ]);
    expect(Object.keys(parsed.pins[0].region)).toEqual(["x", "y", "w", "h"]);
  });

  it("orders the keys of a frame, which the media schema reads as unknown", () => {
    const frames = JSON.parse(serialize("reference", scramble(video()))).media[0].frames;
    expect(Object.keys(frames[0])).toEqual([
      "timeMs",
      "file",
      "type",
      "bytes",
      "sha256",
      "width",
      "height",
    ]);
  });
});

describe("serialize: list and map order", () => {
  it("sorts media and pins by id number and interpretations by piece number", () => {
    const parsed = JSON.parse(serialize("reference", scramble(reference())));
    expect(parsed.media.map((m: Loose) => m.id)).toEqual(["m1", "m2", "m10"]);
    expect(parsed.pins.map((p: Loose) => p.id)).toEqual(["p1", "p2", "p10"]);
    expect(Object.keys(parsed.interpretations)).toEqual(["p0", "p1", "p2", "p10"]);
  });

  it("sorts frames by timeMs", () => {
    const parsed = JSON.parse(serialize("reference", scramble(video())));
    expect(parsed.media[0].frames.map((f: Loose) => f.timeMs)).toEqual([0, 100, 2000]);
  });

  it("keeps the order of the lists the specification leaves to the writer", () => {
    const parsed = JSON.parse(serialize("reference", scramble(reference())));
    expect(parsed.interpretations.p0.content.vocabulary).toEqual(["b", "a"]);
  });

  it("sorts family members by reference id, then piece number", () => {
    const member = (target: string) => ({ target, origin: "user", addedAt: T1 });
    const family = {
      formatVersion: 1,
      slug: "quiet",
      createdAt: T1,
      updatedAt: T2,
      description: userValue({ name: "Quiet", meaning: "m", vocabulary: [] }),
      members: [
        member("ref-20261104-k3x9ab#p10"),
        member("ref-20261105-aaaaaa#p0"),
        member("ref-20261104-k3x9ab#p2"),
        member("ref-20261104-k3x9ab#p0"),
      ],
    };
    const parsed = JSON.parse(serialize("family", family));
    expect(parsed.members.map((m: Loose) => m.target)).toEqual([
      "ref-20261104-k3x9ab#p0",
      "ref-20261104-k3x9ab#p2",
      "ref-20261104-k3x9ab#p10",
      "ref-20261105-aaaaaa#p0",
    ]);
  });

  it("sorts terms, guardrails and statements by id", () => {
    const term = (id: string) => ({
      id,
      createdAt: T1,
      updatedAt: T1,
      pieces: [],
      entry: userValue({ term: id, definition: "d" }),
    });
    const glossary = { formatVersion: 1, terms: [term("term-bbbbbb"), term("term-aaaaaa")] };
    expect(JSON.parse(serialize("glossary", glossary)).terms.map((t: Loose) => t.id)).toEqual([
      "term-aaaaaa",
      "term-bbbbbb",
    ]);
    const guardrail = (id: string) => ({
      id,
      createdAt: T1,
      updatedAt: T1,
      sources: [],
      rule: userValue({ text: "r" }),
    });
    const guardrails = {
      formatVersion: 1,
      guardrails: [guardrail("gr-bbbbbb"), guardrail("gr-aaaaaa")],
    };
    expect(
      JSON.parse(serialize("guardrails", guardrails)).guardrails.map((g: Loose) => g.id),
    ).toEqual(["gr-aaaaaa", "gr-bbbbbb"]);
    const statement = (id: string) => ({
      id,
      createdAt: T1,
      updatedAt: T1,
      evidence: [],
      statement: userValue({ kind: "like", text: "t" }),
    });
    const profile = {
      formatVersion: 1,
      statements: [statement("st-bbbbbb"), statement("st-aaaaaa")],
    };
    expect(
      JSON.parse(serialize("taste-profile", profile)).statements.map((s: Loose) => s.id),
    ).toEqual(["st-aaaaaa", "st-bbbbbb"]);
  });

  it("sorts directions by id number and keeps a direction's pieces in the order chosen", () => {
    const direction = (id: string) => ({
      id,
      createdAt: T1,
      updatedAt: T1,
      family: null,
      pieces: ["ref-20261104-k3x9ab#p2", "ref-20261104-k3x9ab#p1"],
      guardrails: [],
      plan: userValue({ title: "t", why: "w" }),
    });
    const file = {
      formatVersion: 1,
      directions: [direction("d10"), direction("d2")],
      lastIssued: { direction: 10 },
    };
    const parsed = JSON.parse(serialize("directions", file));
    expect(parsed.directions.map((d: Loose) => d.id)).toEqual(["d2", "d10"]);
    expect(parsed.directions[0].pieces).toEqual([
      "ref-20261104-k3x9ab#p2",
      "ref-20261104-k3x9ab#p1",
    ]);
  });

  it("keeps a project's discarded list in the order the agent listed it", () => {
    const project = {
      formatVersion: 1,
      slug: "site",
      createdAt: T1,
      updatedAt: T1,
      name: "Site",
      intent: null,
      discarded: [
        { text: "z", category: "color" },
        { text: "a", category: "font" },
      ],
    };
    expect(JSON.parse(serialize("project", project)).discarded.map((d: Loose) => d.text)).toEqual([
      "z",
      "a",
    ]);
  });

  it("serializes the library file and the media marker", () => {
    const library = {
      formatVersion: 1,
      id: "lib-7d2k9q4m1x",
      name: "Mine",
      language: "en",
      createdAt: T1,
    };
    expect(serialize("library", scramble(library))).toBe(`${JSON.stringify(library, null, 2)}\n`);
    const marker = { formatVersion: 1, libraryId: "lib-7d2k9q4m1x" };
    expect(serialize("marker", scramble(marker))).toBe(`${JSON.stringify(marker, null, 2)}\n`);
  });
});

describe("serialize: determinism", () => {
  it("gives the same bytes for the same data in any key or list order", () => {
    expect(serialize("reference", scramble(reference()))).toBe(serialize("reference", reference()));
    expect(serialize("reference", scramble(video()))).toBe(serialize("reference", video()));
  });

  it("gives the same bytes when serialized twice", () => {
    const once = serialize("reference", reference());
    expect(serialize("reference", JSON.parse(once))).toBe(once);
  });

  it("does not change its input", () => {
    const value = reference();
    const copy = structuredClone(value);
    serialize("reference", value);
    expect(value).toEqual(copy);
  });

  it("refuses an invalid value instead of repairing it", () => {
    const value = reference();
    value.pins[0].region.w = -0.1;
    expect(() => serialize("reference", value)).toThrow();
  });
});

describe("rounding of proportions", () => {
  it("never lets rounding push a valid region beyond the edge", () => {
    expect(roundAxis(0.1234565, 0.8765435)).toEqual({ position: 0.123457, size: 0.876543 });
  });

  it("keeps a tiny size above zero and a far position inside", () => {
    expect(roundAxis(0.5, 4e-7).size).toBe(1e-6);
    expect(roundAxis(1 - 1e-9, 1e-9)).toEqual({ position: 0.999999, size: 1e-6 });
  });

  it("leaves a region with at most 6 decimals unchanged and is idempotent", () => {
    const region = { x: 0.08, y: 0.12, w: 0.4, h: 0.3 };
    expect(roundRegion(region)).toEqual(region);
    const odd = roundRegion({ x: 0.1234565, y: 0.3333333, w: 0.8765435, h: 0.6666667 });
    expect(roundRegion(odd)).toEqual(odd);
  });

  it("holds x + w ≤ 1 and y + h ≤ 1 for many valid regions", () => {
    let seed = 12345;
    const next = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    for (let i = 0; i < 20000; i += 1) {
      const x = next();
      const y = next();
      const w = Math.max(next() * (1 - x), 1e-9);
      const h = Math.max(next() * (1 - y), 1e-9);
      if (x + w > 1 || y + h > 1) continue;
      const out = roundRegion({ x, y, w, h });
      expect(out.x + out.w).toBeLessThanOrEqual(1 + 1e-9);
      expect(out.y + out.h).toBeLessThanOrEqual(1 + 1e-9);
      expect(out.w).toBeGreaterThan(0);
      expect(out.h).toBeGreaterThan(0);
    }
  });

  it("rounds the regions of a reference and the result is valid", () => {
    const value = reference();
    value.pins[0].region = { x: 0.1234565, y: 0.1, w: 0.8765435, h: 0.5 };
    const out = canonicalize("reference", value);
    expect(out.pins[0]?.region).toEqual({ x: 0.123457, y: 0.1, w: 0.876543, h: 0.5 });
    expect(() => canonicalize("reference", out)).not.toThrow();
  });
});

/** Bytes → reader → schema → the not-canonical verdict, the path a validated file takes. */
function verdict(text: string | Uint8Array, type: "reference" = "reference") {
  const bytes = typeof text === "string" ? enc(text) : text;
  const read = readLibraryJson(bytes, "references/r.json");
  if (!read.ok) throw new Error("the file must read");
  const parsed = ReferenceSchema.safeParse(read.value);
  expect(parsed.success).toBe(true);
  return { read, issue: canonicalIssue(type, "references/r.json", read, parsed.data) };
}

describe("not-canonical: every cause of format-spec §3.3", () => {
  const value = reference();
  const canonical = serialize("reference", value);
  const layout = (v: unknown, space: number) => `${JSON.stringify(v, null, space)}\n`;

  it("accepts the canonical bytes", () => {
    expect(verdict(canonical).issue).toBeNull();
  });

  it("reports a byte order mark", () => {
    const { read, issue } = verdict(`﻿${canonical}`);
    expect(read.ok && read.hadBom).toBe(true);
    expect(issue).toMatchObject({ code: "not-canonical", severity: "warning" });
    expect(issue?.message).toContain("byte order mark");
  });

  it("reports CRLF line endings", () => {
    const { read, issue } = verdict(canonical.replaceAll("\n", "\r\n"));
    expect(read.ok && read.hadCr).toBe(true);
    expect(issue?.code).toBe("not-canonical");
    expect(issue?.message).toContain("CRLF");
  });

  it("reports a missing or a doubled final LF", () => {
    expect(verdict(canonical.slice(0, -1)).issue?.code).toBe("not-canonical");
    expect(verdict(`${canonical}\n`).issue?.code).toBe("not-canonical");
  });

  it("reports other whitespace and indentation", () => {
    const canonicalValue = canonicalize("reference", value);
    expect(verdict(JSON.stringify(value)).issue?.code).toBe("not-canonical");
    expect(verdict(layout(canonicalValue, 4)).issue?.code).toBe("not-canonical");
  });

  it("reports keys out of order", () => {
    const text = layout(scramble(canonicalize("reference", value)), 2);
    expect(verdict(text).issue?.code).toBe("not-canonical");
  });

  it("reports list entries out of order", () => {
    const shuffled = canonicalize("reference", value) as Loose;
    shuffled.pins = [...shuffled.pins].reverse();
    expect(verdict(layout(shuffled, 2)).issue?.code).toBe("not-canonical");
  });

  it("reports needless \\u escapes", () => {
    expect(verdict(canonical.replace("Usuário", "Usu\\u00e1rio")).issue?.code).toBe(
      "not-canonical",
    );
  });

  it("reports a number written as 1.0", () => {
    const text = canonical.replace('"formatVersion": 1,', '"formatVersion": 1.0,');
    expect(text).not.toBe(canonical);
    expect(verdict(text).issue?.code).toBe("not-canonical");
  });

  it("reports a region with more than 6 decimals, and the rewrite is canonical", () => {
    const precise = reference();
    precise.pins[0].region = { x: 0.1234565, y: 0.1, w: 0.8765435, h: 0.5 };
    // Everything canonical except the region, which is written as it was given.
    const text = serialize("reference", reference()).replace(
      /"region": \{[^}]*\}/,
      `"region": ${JSON.stringify(precise.pins[0].region, null, 2).replaceAll("\n", "\n      ")}`,
    );
    const { issue } = verdict(text);
    expect(issue?.code).toBe("not-canonical");
    const rewritten = serialize("reference", precise);
    expect(rewritten).toContain('"x": 0.123457');
    expect(verdict(rewritten).issue).toBeNull();
  });

  it("is false for bytes of another value", () => {
    expect(isCanonical("reference", value, enc(serialize("reference", video())))).toBe(false);
  });
});

describe("serialize: key order of every file type, agent forms included", () => {
  const agent = (proposal: unknown) => ({
    origin: "agent",
    proposedBy: "claude-code",
    proposedAt: T1,
    inputSha256: null,
    proposal,
    status: "corrected",
    correction: proposal,
    reviewedAt: T2,
  });
  const files: [Parameters<typeof serialize>[0], Loose][] = [
    [
      "family",
      {
        formatVersion: 1,
        slug: "quiet",
        createdAt: T1,
        updatedAt: T2,
        description: agent({ name: "Quiet", meaning: "m", vocabulary: ["a"] }),
        members: [
          {
            target: "ref-20261104-k3x9ab#p0",
            origin: "agent",
            proposedBy: "claude-code",
            proposedAt: T1,
            status: "accepted",
            reviewedAt: T2,
          },
          { target: "ref-20261104-k3x9ab#p1", origin: "user", addedAt: T1 },
        ],
      },
    ],
    [
      "glossary",
      {
        formatVersion: 1,
        terms: [
          {
            id: "term-aaaaaa",
            createdAt: T1,
            updatedAt: T1,
            pieces: ["ref-20261104-k3x9ab#p0"],
            entry: agent({ term: "t", definition: "d" }),
          },
        ],
      },
    ],
    [
      "guardrails",
      {
        formatVersion: 1,
        guardrails: [
          {
            id: "gr-aaaaaa",
            createdAt: T1,
            updatedAt: T1,
            sources: [],
            rule: agent({ text: "r" }),
          },
        ],
      },
    ],
    [
      "taste-profile",
      {
        formatVersion: 1,
        statements: [
          {
            id: "st-aaaaaa",
            createdAt: T1,
            updatedAt: T1,
            evidence: [],
            statement: agent({ kind: "like", text: "t" }),
          },
        ],
      },
    ],
    [
      "project",
      {
        formatVersion: 1,
        slug: "site",
        createdAt: T1,
        updatedAt: T1,
        name: "Site",
        intent: agent({ what: "w", forWhom: "f", userTasks: ["a"], why: "y" }),
        discarded: [{ text: "z", category: "color" }],
      },
    ],
    [
      "directions",
      {
        formatVersion: 1,
        directions: [
          {
            id: "d1",
            createdAt: T1,
            updatedAt: T1,
            family: null,
            pieces: [],
            guardrails: [],
            plan: agent({ title: "t", why: "w" }),
          },
        ],
        lastIssued: { direction: 1 },
      },
    ],
  ];
  for (const [type, value] of files) {
    it(`gives the same bytes for ${type} in any key order`, () => {
      const text = serialize(type, value);
      expect(serialize(type, scramble(value))).toBe(text);
      expect(serialize(type, JSON.parse(text))).toBe(text);
    });
  }
});
