import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GOLDEN_V1 } from "../../test/support/golden.js";
import type { Json } from "../../test/support/library.js";
import {
  pieceMatcher,
  withoutDirectionLink,
  withoutFamilyLink,
  withoutGuardrailLink,
  withoutPieceLinks,
} from "./remove-links.js";

const A = "ref-20261101-a1b2c3";
const G = "ref-20261103-g7h8j9";
const M = "ref-20261104-m2n3p4";

const golden = (path: string): Json =>
  JSON.parse(readFileSync(join(GOLDEN_V1, ...path.split("/")), "utf8"));

/** Calls `fn` on a frozen deep copy, so a mutation of the input throws. */
function frozen<T>(value: T): T {
  const copy = structuredClone(value);
  const freeze = (item: unknown): void => {
    if (typeof item !== "object" || item === null) return;
    Object.freeze(item);
    for (const child of Object.values(item)) freeze(child);
  };
  freeze(copy);
  return copy;
}

describe("pieceMatcher", () => {
  it("matches one piece, or every piece of a reference", () => {
    const pin = pieceMatcher(A, "p1");
    expect(pin(`${A}#p1`)).toBe(true);
    expect(pin(`${A}#p10`)).toBe(false);
    expect(pin(`${A}#p0`)).toBe(false);
    expect(pin(`${G}#p1`)).toBe(false);
    const reference = pieceMatcher(A);
    expect(reference(`${A}#p0`)).toBe(true);
    expect(reference(`${A}#p12`)).toBe(true);
    expect(reference(`${G}#p0`)).toBe(false);
    expect(reference("ref-20261101-a1b2c34#p0")).toBe(false);
  });
});

describe("withoutPieceLinks", () => {
  it("removes a pin from family members and nothing else", () => {
    const family = frozen(golden("families/quiet-editorial.json"));
    const next = withoutPieceLinks("family", family, pieceMatcher(A, "p1")) as Json;
    expect(next.members.map((m: Json) => m.target)).toEqual([`${A}#p0`, `${G}#p0`, `${G}#p1`]);
    expect({ ...next, members: family.members }).toEqual(family);
  });

  it("removes every piece of a reference from glossary terms, keeping the words and timestamps", () => {
    const glossary = frozen(golden("glossary.json"));
    const next = withoutPieceLinks("glossary", glossary, pieceMatcher(A)) as Json;
    expect(next.terms.map((t: Json) => t.pieces)).toEqual([[], [], [`${G}#p0`], []]);
    next.terms.forEach((term: Json, index: number) => {
      expect({ ...term, pieces: glossary.terms[index].pieces }).toEqual(glossary.terms[index]);
    });
  });

  it("removes sources, evidence and direction pieces", () => {
    const guardrails = withoutPieceLinks(
      "guardrails",
      frozen(golden("guardrails.json")),
      pieceMatcher(A, "p2"),
    ) as Json;
    expect(guardrails.guardrails.map((g: Json) => g.sources)).toEqual([[], [`${G}#p1`]]);
    const profile = withoutPieceLinks(
      "taste-profile",
      frozen(golden("taste-profile.json")),
      pieceMatcher(A),
    ) as Json;
    expect(profile.statements.map((s: Json) => s.evidence)).toEqual([[], []]);
    const directions = withoutPieceLinks(
      "directions",
      frozen(golden("projects/landing-redesign/directions.json")),
      pieceMatcher(G),
    ) as Json;
    expect(directions.directions.map((d: Json) => d.pieces)).toEqual([[`${A}#p0`], []]);
    expect(directions.lastIssued).toEqual({ direction: 2 });
  });

  it("gives null when the file holds no link to the pieces", () => {
    expect(withoutPieceLinks("glossary", golden("glossary.json"), pieceMatcher(M))).toBeNull();
    expect(
      withoutPieceLinks("family", golden("families/dense-dashboards.json"), pieceMatcher(A)),
    ).toBeNull();
    expect(
      withoutPieceLinks("reference", golden(`references/${M}.json`), pieceMatcher(A)),
    ).toBeNull();
  });
});

describe("links to a family, a guardrail and a direction", () => {
  const directions = () => frozen(golden("projects/landing-redesign/directions.json"));

  it("sets a direction's family to null", () => {
    const next = withoutFamilyLink(directions(), "quiet-editorial") as Json;
    expect(next.directions.map((d: Json) => d.family)).toEqual([null, null]);
    expect(withoutFamilyLink(directions(), "dense-dashboards")).toBeNull();
  });

  it("removes a guardrail from directions", () => {
    const next = withoutGuardrailLink(directions(), "gr-3k7m2q") as Json;
    expect(next.directions.map((d: Json) => d.guardrails)).toEqual([[], []]);
    expect(withoutGuardrailLink(directions(), "gr-8r5t1w")).toBeNull();
  });

  it("sets a result's direction to null, keeping its project", () => {
    const reference = frozen(golden(`references/${M}.json`));
    const next = withoutDirectionLink(reference, "landing-redesign", "d1") as Json;
    expect(next.result).toEqual({ project: "landing-redesign", direction: null });
    expect({ ...next, result: reference.result }).toEqual(reference);
    expect(withoutDirectionLink(reference, "landing-redesign", "d2")).toBeNull();
    expect(withoutDirectionLink(reference, "internal-dashboard", "d1")).toBeNull();
    expect(
      withoutDirectionLink(golden(`references/${A}.json`), "landing-redesign", "d1"),
    ).toBeNull();
  });
});
