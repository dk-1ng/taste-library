import { describe, expect, it } from "vitest";
import type { Json } from "../../test/support/library.js";
import { goldenSnapshot } from "../../test/support/snapshot.js";
import type { Snapshot } from "../validation/library.js";
import {
  planDirectionDeletion,
  planFamilyDeletion,
  planGuardrailDeletion,
  planPinDeletion,
  planReferenceDeletion,
} from "./delete.js";
import type { Plan } from "./plan.js";

const A = "ref-20261101-a1b2c3";
const G = "ref-20261103-g7h8j9";
const M = "ref-20261104-m2n3p4";
const REF_A = `references/${A}.json`;
const FAMILY = "families/quiet-editorial.json";
const DIRECTIONS = "projects/landing-redesign/directions.json";

const paths = (plan: Plan) => plan.changes.map((change) => change.path);
const next = (plan: Plan, path: string): Json =>
  plan.changes.find((change) => change.path === path)?.next;
const valueIn = (snapshot: Snapshot, path: string): Json => snapshot.files.get(path)?.value;

describe("deleting a pin", () => {
  it("rewrites the reference first, then removes the links in sorted holders", () => {
    const snapshot = goldenSnapshot();
    const plan = planPinDeletion(snapshot, A, "p1");
    expect(paths(plan)).toEqual([REF_A, FAMILY, "taste-profile.json"]);
    expect(plan.skipped).toEqual([]);
    expect(plan.blockedBy).toBeUndefined();

    const reference = next(plan, REF_A);
    const before = valueIn(snapshot, REF_A);
    expect(reference.pins.map((pin: Json) => pin.id)).toEqual(["p2"]);
    expect(Object.keys(reference.interpretations)).toEqual(["p0", "p2"]);
    expect(reference.lastIssued).toEqual({ media: 2, pin: 2 });
    expect(reference.updatedAt).toBe(before.updatedAt);
    expect(reference.note).toBe(before.note);

    expect(next(plan, FAMILY).members.map((m: Json) => m.target)).not.toContain(`${A}#p1`);
    expect(next(plan, "taste-profile.json").statements[0].evidence).toEqual([`${A}#p0`]);
  });

  it("keeps the pin counter when the highest pin is deleted", () => {
    const plan = planPinDeletion(goldenSnapshot(), A, "p2");
    expect(paths(plan)).toEqual([REF_A, "guardrails.json", "taste-profile.json"]);
    expect(next(plan, REF_A).lastIssued.pin).toBe(2);
    expect(next(plan, "guardrails.json").guardrails[0].sources).toEqual([]);
  });

  it("removes only the leftover links when the pin is already gone", () => {
    const snapshot = goldenSnapshot((files) => {
      (files.get("glossary.json") as Json).terms[1].pieces.push(`${A}#p7`);
    });
    const plan = planPinDeletion(snapshot, A, "p7");
    expect(paths(plan)).toEqual(["glossary.json"]);
    expect(next(plan, "glossary.json").terms[1].pieces).toEqual([]);
    expect(planPinDeletion(goldenSnapshot(), A, "p7").changes).toEqual([]);
  });

  it("removes the leftover links when the whole reference is gone", () => {
    const snapshot = goldenSnapshot((files) => files.delete(REF_A));
    expect(paths(planPinDeletion(snapshot, A, "p1"))).toEqual([FAMILY, "taste-profile.json"]);
  });

  it("is blocked by the reference when the reference has errors", () => {
    const snapshot = goldenSnapshot((files) => files.set(REF_A, "{ broken"));
    const plan = planPinDeletion(snapshot, A, "p1");
    expect(plan.blockedBy).toEqual([REF_A]);
    expect(paths(plan)).not.toContain(REF_A);
  });
});

describe("deleting a reference", () => {
  it("deletes the file first, then removes every link to its pieces", () => {
    const plan = planReferenceDeletion(goldenSnapshot(), A);
    expect(plan.changes[0]).toEqual({ path: REF_A, next: null });
    expect(paths(plan)).toEqual([
      REF_A,
      FAMILY,
      "glossary.json",
      "guardrails.json",
      DIRECTIONS,
      "taste-profile.json",
    ]);
    expect(next(plan, FAMILY).members.map((m: Json) => m.target)).toEqual([`${G}#p0`, `${G}#p1`]);
    expect(next(plan, DIRECTIONS).directions[0].pieces).toEqual([`${G}#p0`]);
  });

  it("skips holders with errors and names the reason, and still deletes", () => {
    const snapshot = goldenSnapshot((files) => {
      files.set("glossary.json", "{ broken");
      (files.get("guardrails.json") as Json).formatVersion = 9;
      (files.get(FAMILY) as Json).members = "broken";
    });
    const plan = planReferenceDeletion(snapshot, A);
    expect(paths(plan)).toEqual([REF_A, DIRECTIONS, "taste-profile.json"]);
    expect(plan.skipped).toEqual([
      { path: FAMILY, reason: "invalid" },
      { path: "glossary.json", reason: "invalid" },
      { path: "guardrails.json", reason: "newer" },
    ]);
  });

  it("skips a folder that could not be listed and may hold links", () => {
    const plan = planReferenceDeletion(goldenSnapshot(undefined, { unlisted: ["families"] }), A);
    expect(paths(plan)).not.toContain(FAMILY);
    expect(plan.skipped).toEqual([{ path: "families", reason: "unreadable" }]);
    // A folder that cannot hold a link to a piece is not listed.
    const other = planReferenceDeletion(goldenSnapshot(undefined, { unlisted: ["references"] }), M);
    expect(other.skipped).toEqual([]);
  });

  it("is blocked by its own file when its folder could not be listed", () => {
    const plan = planReferenceDeletion(goldenSnapshot(undefined, { unlisted: ["references"] }), A);
    expect(plan.blockedBy).toEqual([REF_A]);
    expect(paths(plan)).not.toContain(REF_A);
  });

  it("removes only the leftover links when the file is already gone, and nothing when none is left", () => {
    const gone = goldenSnapshot((files) => files.delete(REF_A));
    expect(paths(planReferenceDeletion(gone, A))[0]).toBe(FAMILY);
    expect(planReferenceDeletion(goldenSnapshot(), "ref-20261230-b1c2d3")).toEqual({
      changes: [],
      skipped: [],
    });
  });
});

describe("deleting a family", () => {
  it("deletes the file first, then sets the directions' family to null", () => {
    const plan = planFamilyDeletion(goldenSnapshot(), "quiet-editorial");
    expect(plan.changes[0]).toEqual({ path: FAMILY, next: null });
    expect(paths(plan)).toEqual([FAMILY, DIRECTIONS]);
    expect(next(plan, DIRECTIONS).directions[0].family).toBeNull();
    expect(next(plan, DIRECTIONS).directions[0].pieces).toHaveLength(2);
  });

  it("skips a projects folder that could not be listed", () => {
    const plan = planFamilyDeletion(
      goldenSnapshot(undefined, { unlisted: ["projects/landing-redesign"] }),
      "quiet-editorial",
    );
    expect(paths(plan)).toEqual([FAMILY]);
    expect(plan.skipped).toEqual([{ path: "projects/landing-redesign", reason: "unreadable" }]);
  });
});

describe("deleting a guardrail", () => {
  it("removes the entry first, keeping the file, then removes it from directions", () => {
    const plan = planGuardrailDeletion(goldenSnapshot(), "gr-3k7m2q");
    expect(paths(plan)).toEqual(["guardrails.json", DIRECTIONS]);
    expect(next(plan, "guardrails.json").guardrails.map((g: Json) => g.id)).toEqual(["gr-8r5t1w"]);
    expect(next(plan, DIRECTIONS).directions[0].guardrails).toEqual([]);
  });

  it("keeps an empty guardrails file", () => {
    const snapshot = goldenSnapshot((files) => {
      (files.get("guardrails.json") as Json).guardrails.pop();
    });
    const plan = planGuardrailDeletion(snapshot, "gr-3k7m2q");
    expect(next(plan, "guardrails.json")).toEqual({ formatVersion: 1, guardrails: [] });
  });

  it("is blocked by guardrails.json when it has errors", () => {
    const snapshot = goldenSnapshot((files) => files.set("guardrails.json", "[]"));
    const plan = planGuardrailDeletion(snapshot, "gr-3k7m2q");
    expect(plan.blockedBy).toEqual(["guardrails.json"]);
    expect(paths(plan)).toEqual([DIRECTIONS]);
  });
});

describe("deleting a direction", () => {
  it("removes the entry first, keeping the counter, then the results that point to it", () => {
    const plan = planDirectionDeletion(goldenSnapshot(), "landing-redesign", "d2");
    expect(paths(plan)).toEqual([DIRECTIONS]);
    expect(next(plan, DIRECTIONS).lastIssued).toEqual({ direction: 2 });

    const first = planDirectionDeletion(goldenSnapshot(), "landing-redesign", "d1");
    expect(paths(first)).toEqual([DIRECTIONS, `references/${M}.json`]);
    expect(next(first, DIRECTIONS).directions.map((d: Json) => d.id)).toEqual(["d2"]);
    expect(next(first, `references/${M}.json`).result).toEqual({
      project: "landing-redesign",
      direction: null,
    });
  });

  it("skips references with errors and a references folder that could not be listed", () => {
    const broken = goldenSnapshot((files) => files.set(`references/${G}.json`, "{"));
    expect(planDirectionDeletion(broken, "landing-redesign", "d1").skipped).toEqual([
      { path: `references/${G}.json`, reason: "invalid" },
    ]);
    const unlisted = goldenSnapshot(undefined, { unlisted: ["references"] });
    const plan = planDirectionDeletion(unlisted, "landing-redesign", "d1");
    expect(paths(plan)).toEqual([DIRECTIONS]);
    expect(plan.skipped).toEqual([{ path: "references", reason: "unreadable" }]);
  });
});

describe("every planner", () => {
  it("leaves the snapshot's values untouched", () => {
    const snapshot = goldenSnapshot();
    const before = structuredClone([...snapshot.files.values()].map((file) => file.value));
    planPinDeletion(snapshot, A, "p1");
    planReferenceDeletion(snapshot, A);
    planFamilyDeletion(snapshot, "quiet-editorial");
    planGuardrailDeletion(snapshot, "gr-3k7m2q");
    planDirectionDeletion(snapshot, "landing-redesign", "d1");
    expect([...snapshot.files.values()].map((file) => file.value)).toEqual(before);
  });

  it("throws, as a bug, for a malformed identifier", () => {
    const snapshot = goldenSnapshot();
    expect(() => planPinDeletion(snapshot, A, "p0")).toThrow();
    expect(() => planPinDeletion(snapshot, A, "m1")).toThrow();
    expect(() => planPinDeletion(snapshot, "ref-1", "p1")).toThrow();
    expect(() => planReferenceDeletion(snapshot, "../library")).toThrow();
    expect(() => planFamilyDeletion(snapshot, "Quiet Editorial")).toThrow();
    expect(() => planFamilyDeletion(snapshot, "con")).toThrow();
    expect(() => planGuardrailDeletion(snapshot, "gr-3k7m2")).toThrow();
    expect(() => planDirectionDeletion(snapshot, "landing-redesign", "d0")).toThrow();
    expect(() => planDirectionDeletion(snapshot, "../x", "d1")).toThrow();
  });
});
