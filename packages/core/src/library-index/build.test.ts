import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Json } from "../../test/support/library.js";
import { goldenSnapshot } from "../../test/support/snapshot.js";
import {
  planDirectionDeletion,
  planFamilyDeletion,
  planGuardrailDeletion,
  planPinDeletion,
  planReferenceDeletion,
} from "../changes/delete.js";
import type { Plan } from "../changes/plan.js";
import { type CrossFile, crossFileIssues, type LinkEvent } from "../validation/cross.js";
import type { Snapshot } from "../validation/library.js";
import { type Backlink, buildIndex, type LibraryIndex } from "./build.js";
import { buildTargets } from "./targets.js";
import { versionSummary } from "./versions.js";

const A = "ref-20261101-a1b2c3";
const B = "ref-20261102-d4e5f6";
const C = "ref-20261103-g7h8j9";
const D = "ref-20261104-m2n3p4";

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** The index of a snapshot, built from its parsed files with the pure functions. */
function indexOf(snapshot: Snapshot): LibraryIndex {
  const files = new Map<string, CrossFile>(
    [...snapshot.files].map(([path, file]) => [
      path,
      {
        kind: file.kind,
        status: file.status,
        formatVersion: file.formatVersion,
        value: file.value,
      },
    ]),
  );
  const targets = buildTargets(files, 1, snapshot.unlistedFolders);
  const versions = versionSummary(files, 1);
  const links: LinkEvent[] = [];
  crossFileIssues(files, {
    current: 1,
    sha256,
    unlistedFolders: snapshot.unlistedFolders,
    targets,
    versions,
    onLink: (link) => void links.push(link),
  });
  return buildIndex({ files, current: 1, targets, links, versions });
}

const at = (links: readonly Backlink[] | undefined): [string, string, string][] =>
  (links ?? []).map((link) => [link.file, link.pointer, link.state]);

describe("the index: references", () => {
  it("derives the state of every golden reference, a rejected pin counting as reviewed", () => {
    const index = indexOf(goldenSnapshot());
    expect([...index.references.keys()]).toEqual([A, B, C, D]);
    expect([...index.references.values()].map((reference) => reference.state)).toEqual([
      "processed",
      "inbox",
      "reviewed",
      "processed",
    ]);
    expect(index.references.get(A)).toEqual({
      id: A,
      path: `references/${A}.json`,
      pieces: ["p0", "p1", "p2"],
      state: "processed",
      result: null,
    });
    expect(index.references.get(D)?.result).toEqual({
      project: "landing-redesign",
      direction: "d1",
    });
  });

  it("leaves out a reference with errors", () => {
    const index = indexOf(goldenSnapshot((files) => void files.set(`references/${A}.json`, "{")));
    expect([...index.references.keys()]).toEqual([B, C, D]);
  });
});

describe("the index: families", () => {
  it("lists the counting members of each family, a link to review being tentative", () => {
    const index = indexOf(goldenSnapshot());
    expect([...index.families.keys()]).toEqual(["dense-dashboards", "quiet-editorial"]);
    expect(index.families.get("quiet-editorial")).toEqual({
      slug: "quiet-editorial",
      path: "families/quiet-editorial.json",
      tentative: false,
      members: [
        { target: `${A}#p0`, tentative: false },
        { target: `${A}#p1`, tentative: true },
        { target: `${C}#p0`, tentative: false },
      ],
    });
    expect(index.families.get("dense-dashboards")?.members).toEqual([
      { target: `${D}#p0`, tentative: false },
    ]);
    expect(index.familiesOf.get(`${C}#p1`)).toBeUndefined(); // a rejected link gives nothing
    expect(index.familiesOf.get(`${A}#p1`)).toEqual([{ slug: "quiet-editorial", tentative: true }]);
  });

  it("gives a piece its families sorted by slug", () => {
    const index = indexOf(
      goldenSnapshot((files) => {
        const family = files.get("families/dense-dashboards.json") as Json;
        family.members.unshift({ target: `${A}#p0`, origin: "user", addedAt: family.createdAt });
      }),
    );
    expect(index.familiesOf.get(`${A}#p0`)).toEqual([
      { slug: "dense-dashboards", tentative: false },
      { slug: "quiet-editorial", tentative: false },
    ]);
  });

  it("makes every member tentative when the description is to review", () => {
    const index = indexOf(
      goldenSnapshot((files) => {
        const description = (files.get("families/quiet-editorial.json") as Json).description;
        description.status = "to-review";
        description.reviewedAt = null;
      }),
    );
    const family = index.families.get("quiet-editorial");
    expect(family?.tentative).toBe(true);
    expect(family?.members.map((member) => member.tentative)).toEqual([true, true, true]);
    expect(index.familiesOf.get(`${A}#p0`)).toEqual([{ slug: "quiet-editorial", tentative: true }]);
  });

  it("drops a family whose description is rejected: no piece gets it", () => {
    const index = indexOf(
      goldenSnapshot((files) => {
        (files.get("families/quiet-editorial.json") as Json).description.status = "rejected";
      }),
    );
    expect([...index.families.keys()]).toEqual(["dense-dashboards"]);
    expect(index.familiesOf.get(`${A}#p0`)).toBeUndefined();
    expect(index.familiesOf.get(`${C}#p0`)).toBeUndefined();
    // It still exists for the dangling check.
    expect(index.targets.families.has("quiet-editorial")).toBe(true);
  });

  it("gives nothing for a family file with errors", () => {
    const index = indexOf(
      goldenSnapshot((files) => void files.set("families/quiet-editorial.json", "{")),
    );
    expect([...index.families.keys()]).toEqual(["dense-dashboards"]);
    expect(index.familiesOf.get(`${A}#p0`)).toBeUndefined();
  });

  it("counts no member whose piece does not exist or lies in a file with errors", () => {
    const index = indexOf(
      goldenSnapshot((files) => {
        const family = files.get("families/quiet-editorial.json") as Json;
        family.members.splice(2, 0, {
          target: `${A}#p9`,
          origin: "user",
          addedAt: family.createdAt,
        });
        files.set(`references/${D}.json`, "{");
      }),
    );
    expect(index.families.get("quiet-editorial")?.members.map((member) => member.target)).toEqual([
      `${A}#p0`,
      `${A}#p1`,
      `${C}#p0`,
    ]);
    expect(index.families.get("dense-dashboards")?.members).toEqual([]);
    expect(index.familiesOf.has(`${A}#p9`)).toBe(false);
    expect(index.familiesOf.has(`${D}#p0`)).toBe(false);
  });
});

describe("the index: backlinks", () => {
  /** Links to `piece` added in every kind of file that can hold one (as `linkEverywhere`, in memory). */
  const linkedEverywhere = (piece: string) =>
    goldenSnapshot((files) => {
      const family = files.get("families/dense-dashboards.json") as Json;
      family.members.unshift({ target: piece, origin: "user", addedAt: family.createdAt });
      (files.get("glossary.json") as Json).terms[1].pieces.push(piece);
      (files.get("guardrails.json") as Json).guardrails[1].sources.unshift(piece);
      (files.get("taste-profile.json") as Json).statements[1].evidence.push(piece);
      const directions = files.get("projects/landing-redesign/directions.json") as Json;
      directions.directions[1].pieces.push(piece);
    });

  it("lists every link to a piece, in path order then file order", () => {
    const index = indexOf(linkedEverywhere(`${A}#p1`));
    expect(at(index.backlinks.get(`piece:${A}#p1`))).toEqual([
      ["families/dense-dashboards.json", "/members/0/target", "resolved"],
      ["families/quiet-editorial.json", "/members/1/target", "resolved"],
      ["glossary.json", "/terms/1/pieces/0", "resolved"],
      ["guardrails.json", "/guardrails/1/sources/0", "resolved"],
      ["projects/landing-redesign/directions.json", "/directions/1/pieces/0", "resolved"],
      ["taste-profile.json", "/statements/0/evidence/1", "resolved"],
      ["taste-profile.json", "/statements/1/evidence/1", "resolved"],
    ]);
    expect(index.backlinks.get(`piece:${A}#p1`)?.[2]?.holder).toBe("term-7h9k3m");
  });

  it("lists the result links of a reference and the links of a direction", () => {
    const index = indexOf(goldenSnapshot());
    expect(at(index.backlinks.get("project:landing-redesign"))).toEqual([
      [`references/${D}.json`, "/result/project", "resolved"],
    ]);
    expect(at(index.backlinks.get("direction:landing-redesign/d1"))).toEqual([
      [`references/${D}.json`, "/result/direction", "resolved"],
    ]);
    expect(at(index.backlinks.get("family:quiet-editorial"))).toEqual([
      ["projects/landing-redesign/directions.json", "/directions/0/family", "resolved"],
    ]);
    expect(at(index.backlinks.get("guardrail:gr-3k7m2q"))).toEqual([
      ["projects/landing-redesign/directions.json", "/directions/0/guardrails/0", "resolved"],
    ]);
  });

  it("lists a dangling link, and leaves out the links of a file with errors", () => {
    const index = indexOf(
      goldenSnapshot((files) => {
        (files.get("glossary.json") as Json).terms[1].pieces.push(`${A}#p9`);
        files.set("taste-profile.json", "{");
      }),
    );
    expect(at(index.backlinks.get(`piece:${A}#p9`))).toEqual([
      ["glossary.json", "/terms/1/pieces/0", "dangling"],
    ]);
    const files = [...index.backlinks.values()].flat().map((link) => link.file);
    expect(files).not.toContain("taste-profile.json");
  });

  it("lists links into a file with errors as unresolved", () => {
    const index = indexOf(goldenSnapshot((files) => void files.set(`references/${A}.json`, "{")));
    expect(at(index.backlinks.get(`piece:${A}#p0`))).toEqual([
      ["families/quiet-editorial.json", "/members/0/target", "unresolved"],
      ["glossary.json", "/terms/0/pieces/0", "unresolved"],
      ["projects/landing-redesign/directions.json", "/directions/0/pieces/0", "unresolved"],
      ["taste-profile.json", "/statements/0/evidence/0", "unresolved"],
    ]);
  });

  it("gathers the links to every piece of a reference, also to a pin that is gone", () => {
    const index = indexOf(
      goldenSnapshot((files) => {
        const reference = files.get(`references/${A}.json`) as Json;
        reference.pins = reference.pins.filter((pin: Json) => pin.id !== "p2");
        delete reference.interpretations.p2;
      }),
    );
    expect(at(index.backlinks.get(`piece:${A}#p2`))).toEqual([
      ["guardrails.json", "/guardrails/0/sources/0", "dangling"],
      ["taste-profile.json", "/statements/1/evidence/0", "dangling"],
    ]);
    expect(at(index.backlinksToReference.get(A))).toEqual([
      ["families/quiet-editorial.json", "/members/0/target", "resolved"],
      ["families/quiet-editorial.json", "/members/1/target", "resolved"],
      ["glossary.json", "/terms/0/pieces/0", "resolved"],
      ["guardrails.json", "/guardrails/0/sources/0", "dangling"],
      ["projects/landing-redesign/directions.json", "/directions/0/pieces/0", "resolved"],
      ["taste-profile.json", "/statements/0/evidence/0", "resolved"],
      ["taste-profile.json", "/statements/0/evidence/1", "resolved"],
      ["taste-profile.json", "/statements/1/evidence/0", "dangling"],
    ]);
  });
});

describe("the index agrees with the deletion planners", () => {
  /** The files whose links the plan removes: every change after the primary one. */
  const linkFiles = (plan: Plan, primary: string): string[] =>
    plan.changes.map((change) => change.path).filter((path) => path !== primary);
  const filesOf = (links: readonly Backlink[] | undefined): string[] => [
    ...new Set((links ?? []).map((link) => link.file)),
  ];

  const snapshot = goldenSnapshot();
  const index = indexOf(snapshot);

  it("a reference", () => {
    expect(linkFiles(planReferenceDeletion(snapshot, A), `references/${A}.json`)).toEqual(
      filesOf(index.backlinksToReference.get(A)),
    );
    expect(filesOf(index.backlinksToReference.get(A)).length).toBeGreaterThan(0);
  });

  it("a pin", () => {
    expect(linkFiles(planPinDeletion(snapshot, A, "p2"), `references/${A}.json`)).toEqual(
      filesOf(index.backlinks.get(`piece:${A}#p2`)),
    );
    expect(filesOf(index.backlinks.get(`piece:${A}#p2`)).length).toBeGreaterThan(0);
  });

  it("a family", () => {
    const path = "families/quiet-editorial.json";
    expect(linkFiles(planFamilyDeletion(snapshot, "quiet-editorial"), path)).toEqual(
      filesOf(index.backlinks.get("family:quiet-editorial")),
    );
  });

  it("a guardrail", () => {
    expect(linkFiles(planGuardrailDeletion(snapshot, "gr-3k7m2q"), "guardrails.json")).toEqual(
      filesOf(index.backlinks.get("guardrail:gr-3k7m2q")),
    );
  });

  it("a direction", () => {
    const path = "projects/landing-redesign/directions.json";
    expect(linkFiles(planDirectionDeletion(snapshot, "landing-redesign", "d1"), path)).toEqual(
      filesOf(index.backlinks.get("direction:landing-redesign/d1")),
    );
    expect(filesOf(index.backlinks.get("direction:landing-redesign/d1"))).toEqual([
      `references/${D}.json`,
    ]);
  });
});

describe("the index keeps the version summary", () => {
  it("as given", () => {
    expect(indexOf(goldenSnapshot()).versions).toMatchObject({ library: 1, present: [1] });
  });
});
