import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { issuesFromZod } from "../../validation/zod-issues.js";
import { DirectionsSchema } from "./directions.js";
import { FamilySchema } from "./family.js";
import { GlossarySchema } from "./glossary.js";
import { GuardrailsSchema } from "./guardrails.js";
import { ProjectSchema } from "./project.js";
import { TasteProfileSchema } from "./taste-profile.js";

// biome-ignore lint/suspicious/noExplicitAny: the fixtures are plain JSON that tests mutate by path.
type Loose = any;

const T1 = "2026-11-04T12:00:00.000Z";
const T2 = "2026-11-04T12:05:00.000Z";
const P1 = "ref-20261104-k3x9ab#p0";
const P2 = "ref-20261104-k3x9ab#p1";

const userValue = (content: unknown) => ({ origin: "user", content, writtenAt: T1 });
const agentValue = (proposal: unknown, extra: Loose = {}) => ({
  origin: "agent",
  proposedBy: "claude-code",
  proposedAt: T1,
  inputSha256: null,
  proposal,
  status: "to-review",
  correction: null,
  reviewedAt: null,
  ...extra,
});

function check(schema: z.ZodType, value: unknown) {
  const result = schema.safeParse(value, { reportInput: true });
  return result.success
    ? []
    : issuesFromZod(result.error, "f.json").map((i) => `${i.code} ${i.pointer}`);
}

/** Runs the rules: the example passes and every mutation gives exactly the expected issue. */
function suite(
  name: string,
  schema: z.ZodType,
  example: () => Loose,
  cases: [string, (v: Loose) => void, string][],
) {
  describe(name, () => {
    it("accepts the valid example", () => {
      expect(check(schema, example())).toEqual([]);
    });
    for (const [label, mutate, expected] of cases) {
      it(`refuses: ${label}`, () => {
        const v = example();
        mutate(v);
        expect(check(schema, v)).toEqual([expected]);
      });
    }
  });
}

const family = (): Loose => ({
  formatVersion: 1,
  slug: "quiet-editorial",
  createdAt: T1,
  updatedAt: T2,
  description: userValue({
    name: "Quiet editorial",
    meaning: "Calm, dense.",
    vocabulary: ["calm"],
  }),
  members: [
    { target: P1, origin: "user", addedAt: T1 },
    {
      target: P2,
      origin: "agent",
      proposedBy: "claude-code",
      proposedAt: T1,
      status: "accepted",
      reviewedAt: T2,
    },
  ],
});

suite("family", FamilySchema, family, [
  [
    "a repeated member target",
    (v) => (v.members[1].target = P1),
    "schema-violation /members/1/target",
  ],
  [
    "more than 10000 members",
    (v) =>
      (v.members = Array.from({ length: 10001 }, (_, i) => ({
        target: `ref-20261104-k3x9ab#p${i}`,
        origin: "user",
        addedAt: T1,
      }))),
    "schema-violation /members",
  ],
  [
    "a non-null inputSha256",
    (v) =>
      (v.description = agentValue(
        { name: "A", meaning: "B", vocabulary: [] },
        { inputSha256: "a".repeat(64) },
      )),
    "schema-violation /description/inputSha256",
  ],
  [
    "updatedAt before createdAt",
    (v) => (v.updatedAt = "2026-11-04T11:00:00.000Z"),
    "schema-violation /updatedAt",
  ],
  ["an unknown field", (v) => (v.extra = 1), "schema-violation /extra"],
  ["a bad slug", (v) => (v.slug = "Quiet"), "schema-violation /slug"],
  [
    "an empty meaning",
    (v) => (v.description.content.meaning = ""),
    "schema-violation /description/content/meaning",
  ],
]);

const term = (id: string): Loose => ({
  id,
  createdAt: T1,
  updatedAt: T1,
  pieces: [P1],
  entry: agentValue({ term: "quiet density", definition: "Dense but calm." }),
});
const glossary = (): Loose => ({
  formatVersion: 1,
  terms: [term("term-9x2b7c"), term("term-aaaaaa")],
});

suite("glossary", GlossarySchema, glossary, [
  ["a repeated term id", (v) => (v.terms[1].id = "term-9x2b7c"), "duplicate-id /terms/1/id"],
  ["repeated pieces", (v) => v.terms[0].pieces.push(P1), "schema-violation /terms/0/pieces/1"],
  [
    "more than 100 pieces",
    (v) => (v.terms[0].pieces = Array.from({ length: 101 }, (_, i) => `ref-20261104-k3x9ab#p${i}`)),
    "schema-violation /terms/0/pieces",
  ],
  [
    "more than 10000 terms",
    (v) => (v.terms = Array.from({ length: 10001 }, () => term("term-9x2b7c"))),
    "schema-violation /terms",
  ],
  [
    "a non-null inputSha256",
    (v) => (v.terms[0].entry.inputSha256 = "a".repeat(64)),
    "schema-violation /terms/0/entry/inputSha256",
  ],
  ["a wrong id form", (v) => (v.terms[0].id = "gr-4m8q2z"), "schema-violation /terms/0/id"],
]);

const gr = (id: string): Loose => ({
  id,
  createdAt: T1,
  updatedAt: T1,
  sources: [P2],
  rule: userValue({ text: "No loud heroes." }),
});
const guardrails = (): Loose => ({
  formatVersion: 1,
  guardrails: [gr("gr-4m8q2z"), gr("gr-aaaaaa")],
});

suite("guardrails", GuardrailsSchema, guardrails, [
  ["a repeated id", (v) => (v.guardrails[1].id = "gr-4m8q2z"), "duplicate-id /guardrails/1/id"],
  [
    "repeated sources",
    (v) => v.guardrails[0].sources.push(P2),
    "schema-violation /guardrails/0/sources/1",
  ],
  [
    "a rule over 500 characters",
    (v) => (v.guardrails[0].rule.content.text = "x".repeat(501)),
    "schema-violation /guardrails/0/rule/content/text",
  ],
  [
    "a non-null inputSha256",
    (v) => (v.guardrails[0].rule = agentValue({ text: "x" }, { inputSha256: "a".repeat(64) })),
    "schema-violation /guardrails/0/rule/inputSha256",
  ],
]);

const st = (id: string): Loose => ({
  id,
  createdAt: T1,
  updatedAt: T1,
  evidence: [P1],
  statement: userValue({ kind: "like", text: "Quiet contrast." }),
});
const profile = (): Loose => ({ formatVersion: 1, statements: [st("st-1h6v3r"), st("st-aaaaaa")] });

suite("taste profile", TasteProfileSchema, profile, [
  ["a repeated id", (v) => (v.statements[1].id = "st-1h6v3r"), "duplicate-id /statements/1/id"],
  [
    "repeated evidence",
    (v) => v.statements[0].evidence.push(P1),
    "schema-violation /statements/0/evidence/1",
  ],
  [
    "an unknown kind",
    (v) => (v.statements[0].statement.content.kind = "love"),
    "schema-violation /statements/0/statement/content/kind",
  ],
  [
    "more than 100 evidence",
    (v) =>
      (v.statements[0].evidence = Array.from(
        { length: 101 },
        (_, i) => `ref-20261104-k3x9ab#p${i}`,
      )),
    "schema-violation /statements/0/evidence",
  ],
  [
    "a non-null inputSha256",
    (v) => (v.statements[0].statement.inputSha256 = "a".repeat(64)),
    "schema-violation /statements/0/statement/inputSha256",
  ],
]);

const project = (): Loose => ({
  formatVersion: 1,
  slug: "pricing-redesign",
  createdAt: T1,
  updatedAt: T2,
  name: "Pricing redesign",
  intent: userValue({
    what: "A pricing page",
    forWhom: "Buyers",
    userTasks: ["Compare plans"],
    why: "Convert",
  }),
  discarded: [{ text: "Make it blue", category: "color" }],
});

suite("project", ProjectSchema, project, [
  [
    "more than 20 user tasks",
    (v) => (v.intent.content.userTasks = Array.from({ length: 21 }, () => "t")),
    "schema-violation /intent/content/userTasks",
  ],
  [
    "a user task with a line break",
    (v) => (v.intent.content.userTasks = ["a\nb"]),
    "schema-violation /intent/content/userTasks/0",
  ],
  [
    "a user task over 500 characters",
    (v) => (v.intent.content.userTasks = ["x".repeat(501)]),
    "schema-violation /intent/content/userTasks/0",
  ],
  [
    "an unknown discarded category",
    (v) => (v.discarded[0].category = "mood"),
    "schema-violation /discarded/0/category",
  ],
  [
    "more than 500 discarded",
    (v) => (v.discarded = Array.from({ length: 501 }, () => ({ text: "x", category: "style" }))),
    "schema-violation /discarded",
  ],
  [
    "a non-null inputSha256",
    (v) =>
      (v.intent = agentValue(
        { what: "a", forWhom: "b", userTasks: [], why: "c" },
        { inputSha256: "a".repeat(64) },
      )),
    "schema-violation /intent/inputSha256",
  ],
  [
    "updatedAt before createdAt",
    (v) => (v.updatedAt = "2026-11-04T11:00:00.000Z"),
    "schema-violation /updatedAt",
  ],
]);

describe("project: a null intent", () => {
  it("is valid", () => {
    const v = project();
    v.intent = null;
    expect(check(ProjectSchema, v)).toEqual([]);
  });
});

const dir = (id: string): Loose => ({
  id,
  createdAt: T1,
  updatedAt: T1,
  family: "quiet-editorial",
  pieces: [P1, P2],
  guardrails: ["gr-4m8q2z"],
  plan: userValue({ title: "Quiet", why: "Fits the intent." }),
});
const directions = (): Loose => ({
  formatVersion: 1,
  directions: [dir("d1"), dir("d3")],
  lastIssued: { direction: 3 },
});

suite("directions", DirectionsSchema, directions, [
  ["a repeated id", (v) => (v.directions[1].id = "d1"), "duplicate-id /directions/1/id"],
  [
    "lastIssued below the highest id",
    (v) => (v.lastIssued.direction = 2),
    "schema-violation /lastIssued/direction",
  ],
  [
    "repeated pieces",
    (v) => v.directions[0].pieces.push(P1),
    "schema-violation /directions/0/pieces/2",
  ],
  [
    "repeated guardrails",
    (v) => v.directions[0].guardrails.push("gr-4m8q2z"),
    "schema-violation /directions/0/guardrails/1",
  ],
  [
    "more than 50 directions",
    (v) => (v.directions = Array.from({ length: 51 }, (_, i) => dir(`d${i + 1}`))),
    "schema-violation /directions",
  ],
  [
    "more than 100 pieces",
    (v) =>
      (v.directions[0].pieces = Array.from({ length: 101 }, (_, i) => `ref-20261104-k3x9ab#p${i}`)),
    "schema-violation /directions/0/pieces",
  ],
  [
    "a non-null inputSha256",
    (v) =>
      (v.directions[0].plan = agentValue(
        { title: "a", why: "b" },
        { inputSha256: "a".repeat(64) },
      )),
    "schema-violation /directions/0/plan/inputSha256",
  ],
  [
    "a bad family slug",
    (v) => (v.directions[0].family = "Bad Slug"),
    "schema-violation /directions/0/family",
  ],
]);

describe("directions: valid variants", () => {
  it("accepts a family of null and a lastIssued above the highest id", () => {
    const v = directions();
    v.directions[0].family = null;
    v.lastIssued.direction = 9;
    expect(check(DirectionsSchema, v)).toEqual([]);
  });
  it("accepts an empty file", () => {
    expect(
      check(DirectionsSchema, { formatVersion: 1, directions: [], lastIssued: { direction: 0 } }),
    ).toEqual([]);
  });
});

/** Negative cases only (the valid example is checked by `suite` above). */
function refuses(
  name: string,
  schema: z.ZodType,
  example: () => Loose,
  cases: [string, (v: Loose) => void, string][],
) {
  describe(`${name}: more rules`, () => {
    for (const [label, mutate, expected] of cases) {
      it(`refuses: ${label}`, () => {
        const v = example();
        mutate(v);
        expect(check(schema, v)).toEqual([expected]);
      });
    }
  });
}

const EARLY = "2026-11-04T11:00:00.000Z";
const refs = (n: number) => Array.from({ length: n }, (_, i) => `ref-20261104-k3x9ab#p${i}`);

refuses("family", FamilySchema, family, [
  [
    "a bad vocabulary tag",
    (v) => (v.description.content.vocabulary = [" x"]),
    "schema-violation /description/content/vocabulary/0",
  ],
]);

refuses("glossary", GlossarySchema, glossary, [
  [
    "updatedAt before createdAt",
    (v) => (v.terms[0].updatedAt = EARLY),
    "schema-violation /terms/0/updatedAt",
  ],
  [
    "a term with leading whitespace",
    (v) => (v.terms[0].entry.proposal.term = " x"),
    "schema-violation /terms/0/entry/proposal/term",
  ],
]);

refuses("guardrails", GuardrailsSchema, guardrails, [
  [
    "updatedAt before createdAt",
    (v) => (v.guardrails[0].updatedAt = EARLY),
    "schema-violation /guardrails/0/updatedAt",
  ],
  [
    "more than 10000 guardrails",
    (v) => (v.guardrails = Array.from({ length: 10001 }, () => gr("gr-4m8q2z"))),
    "schema-violation /guardrails",
  ],
  [
    "more than 100 sources",
    (v) => (v.guardrails[0].sources = refs(101)),
    "schema-violation /guardrails/0/sources",
  ],
]);

refuses("taste profile", TasteProfileSchema, profile, [
  [
    "updatedAt before createdAt",
    (v) => (v.statements[0].updatedAt = EARLY),
    "schema-violation /statements/0/updatedAt",
  ],
  [
    "more than 2000 statements",
    (v) => (v.statements = Array.from({ length: 2001 }, () => st("st-1h6v3r"))),
    "schema-violation /statements",
  ],
  [
    "a text over 2000 characters",
    (v) => (v.statements[0].statement.content.text = "x".repeat(2001)),
    "schema-violation /statements/0/statement/content/text",
  ],
]);

refuses("project", ProjectSchema, project, [
  ["an empty what", (v) => (v.intent.content.what = ""), "schema-violation /intent/content/what"],
  [
    "an empty forWhom",
    (v) => (v.intent.content.forWhom = ""),
    "schema-violation /intent/content/forWhom",
  ],
  ["an empty why", (v) => (v.intent.content.why = ""), "schema-violation /intent/content/why"],
  [
    "a discarded text over 500 characters",
    (v) => (v.discarded[0].text = "x".repeat(501)),
    "schema-violation /discarded/0/text",
  ],
]);

refuses("directions", DirectionsSchema, directions, [
  [
    "updatedAt before createdAt",
    (v) => (v.directions[0].updatedAt = EARLY),
    "schema-violation /directions/0/updatedAt",
  ],
  [
    "more than 100 guardrails",
    (v) =>
      (v.directions[0].guardrails = Array.from(
        { length: 101 },
        (_, i) =>
          `gr-${"0123456789abcdefghjkmnpqrstvwxyz"[i % 32]}${"0123456789abcdefghjkmnpqrstvwxyz"[Math.floor(i / 32)]}aaaa`,
      )),
    "schema-violation /directions/0/guardrails",
  ],
  [
    "a bad guardrail id",
    (v) => (v.directions[0].guardrails = ["gr-UPPER"]),
    "schema-violation /directions/0/guardrails/0",
  ],
  [
    "an empty plan title",
    (v) => (v.directions[0].plan.content.title = ""),
    "schema-violation /directions/0/plan/content/title",
  ],
  [
    "an empty plan why",
    (v) => (v.directions[0].plan.content.why = ""),
    "schema-violation /directions/0/plan/content/why",
  ],
  [
    "a fractional lastIssued",
    (v) => (v.lastIssued.direction = 2.5),
    "schema-violation /lastIssued/direction",
  ],
  [
    "a negative lastIssued",
    (v) => (v.lastIssued.direction = -1),
    "schema-violation /lastIssued/direction",
  ],
]);

describe("a malformed value that repeats is reported by its own rule only", () => {
  it("pieces", () => {
    const v = glossary();
    v.terms[0].pieces = ["bad", "bad"];
    expect(check(GlossarySchema, v)).toEqual([
      "schema-violation /terms/0/pieces/0",
      "schema-violation /terms/0/pieces/1",
    ]);
  });
  it("direction guardrails", () => {
    const v = directions();
    v.directions[0].guardrails = ["bad", "bad"];
    expect(check(DirectionsSchema, v)).toEqual([
      "schema-violation /directions/0/guardrails/0",
      "schema-violation /directions/0/guardrails/1",
    ]);
  });
});
