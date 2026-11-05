import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Json } from "../../test/support/library.js";
import { goldenSnapshot } from "../../test/support/snapshot.js";
import { type CrossFile, crossFileIssues, type LinkEvent } from "../validation/cross.js";
import type { Snapshot } from "../validation/library.js";
import { buildTargets, type LinkTarget, targetFileOf, targetKey } from "./targets.js";

const A = "ref-20261101-a1b2c3";
const D = "ref-20261104-m2n3p4";

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

function crossFilesOf(snapshot: Snapshot): Map<string, CrossFile> {
  return new Map(
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
}

function targetsOf(snapshot: Snapshot, current = 1) {
  return buildTargets(crossFilesOf(snapshot), current, snapshot.unlistedFolders);
}

const piece = (ref: string, id: string): LinkTarget => ({ kind: "piece", ref, piece: id });
const family = (slug: string): LinkTarget => ({ kind: "family", slug });
const project = (slug: string): LinkTarget => ({ kind: "project", slug });
const direction = (projectSlug: string, id: string): LinkTarget => ({
  kind: "direction",
  project: projectSlug,
  id,
});
const guardrail = (id: string): LinkTarget => ({ kind: "guardrail", id });

describe("targetKey and targetFileOf", () => {
  it("name each kind of target and the file that holds it", () => {
    const cases: [LinkTarget, string, string][] = [
      [piece(A, "p1"), `piece:${A}#p1`, `references/${A}.json`],
      [family("quiet-editorial"), "family:quiet-editorial", "families/quiet-editorial.json"],
      [
        project("landing-redesign"),
        "project:landing-redesign",
        "projects/landing-redesign/project.json",
      ],
      [
        direction("landing-redesign", "d1"),
        "direction:landing-redesign/d1",
        "projects/landing-redesign/directions.json",
      ],
      [guardrail("gr-3k7m2q"), "guardrail:gr-3k7m2q", "guardrails.json"],
    ];
    for (const [target, key, file] of cases) {
      expect(targetKey(target)).toBe(key);
      expect(targetFileOf(target)).toBe(file);
    }
  });
});

describe("buildTargets", () => {
  it("resolves every kind of target of the golden library", () => {
    const targets = targetsOf(goldenSnapshot());
    for (const target of [
      piece(A, "p0"),
      piece(A, "p2"),
      piece(D, "p0"),
      family("quiet-editorial"),
      family("dense-dashboards"),
      project("landing-redesign"),
      project("internal-dashboard"),
      direction("landing-redesign", "d1"),
      direction("landing-redesign", "d2"),
      guardrail("gr-3k7m2q"),
      guardrail("gr-8r5t1w"),
    ]) {
      expect(targets.resolve(target), targetKey(target)).toBe("resolved");
    }
    expect([...(targets.references.get(A) ?? [])]).toEqual(["p0", "p1", "p2"]);
    expect([...targets.families].sort()).toEqual(["dense-dashboards", "quiet-editorial"]);
    expect([...targets.projects].sort()).toEqual(["internal-dashboard", "landing-redesign"]);
    expect([...(targets.directions.get("landing-redesign") ?? [])]).toEqual(["d1", "d2"]);
    expect([...targets.guardrails]).toEqual(["gr-3k7m2q", "gr-8r5t1w"]);
  });

  it("says dangling when the file or the thing in it is absent", () => {
    const targets = targetsOf(goldenSnapshot());
    for (const target of [
      piece(A, "p9"),
      piece("ref-20991231-zzzzzz", "p0"),
      family("no-such-family"),
      project("no-such-project"),
      direction("landing-redesign", "d9"),
      direction("internal-dashboard", "d1"), // that project has no directions.json
      guardrail("gr-0000000"),
    ]) {
      expect(targets.resolve(target), targetKey(target)).toBe("dangling");
    }
  });

  it("says dangling for every kind when its file is gone, also guardrails.json", () => {
    const targets = targetsOf(
      goldenSnapshot((files) => {
        files.delete(`references/${A}.json`);
        files.delete("families/quiet-editorial.json");
        files.delete("projects/landing-redesign/directions.json");
        files.delete("guardrails.json");
      }),
    );
    expect(targets.resolve(piece(A, "p0"))).toBe("dangling");
    expect(targets.resolve(family("quiet-editorial"))).toBe("dangling");
    expect(targets.resolve(direction("landing-redesign", "d1"))).toBe("dangling");
    expect(targets.resolve(guardrail("gr-3k7m2q"))).toBe("dangling");
  });

  it("says unresolved for a target in a file with errors", () => {
    const targets = targetsOf(
      goldenSnapshot((files) => {
        files.set(`references/${A}.json`, "{");
        files.set("families/quiet-editorial.json", "{");
        files.set("projects/landing-redesign/project.json", "{");
        files.set("projects/landing-redesign/directions.json", "{");
        files.set("guardrails.json", "{");
      }),
    );
    for (const target of [
      piece(A, "p0"),
      piece(A, "p9"),
      family("quiet-editorial"),
      project("landing-redesign"),
      direction("landing-redesign", "d1"),
      guardrail("gr-3k7m2q"),
    ]) {
      expect(targets.resolve(target), targetKey(target)).toBe("unresolved");
    }
    expect(targets.references.has(A)).toBe(false);
    expect(targets.families.has("quiet-editorial")).toBe(false);
  });

  it("says unresolved for a target in a newer file", () => {
    const targets = targetsOf(
      goldenSnapshot((files) => {
        (files.get(`references/${A}.json`) as Json).formatVersion = 2;
      }),
    );
    expect(targets.resolve(piece(A, "p0"))).toBe("unresolved");
  });

  it("says unresolved for a target in a file below the current version", () => {
    // The golden library is at version 1; a tool at version 2 cannot use it before migrating it.
    const targets = targetsOf(goldenSnapshot(), 2);
    expect(targets.resolve(piece(A, "p0"))).toBe("unresolved");
    expect(targets.resolve(family("quiet-editorial"))).toBe("unresolved");
    expect(targets.resolve(guardrail("gr-3k7m2q"))).toBe("unresolved");
    expect(targets.references.size).toBe(0);
  });

  it("says unresolved for a target under a folder that could not be listed, even when it is absent", () => {
    const targets = targetsOf(goldenSnapshot(undefined, { unlisted: ["references"] }));
    expect(targets.resolve(piece(A, "p0"))).toBe("unresolved");
    expect(targets.resolve(piece("ref-20991231-zzzzzz", "p0"))).toBe("unresolved");
    expect(targets.resolve(family("quiet-editorial"))).toBe("resolved");
  });

  it("keeps a family whose description is rejected: existence is about the file", () => {
    const targets = targetsOf(
      goldenSnapshot((files) => {
        (files.get("families/quiet-editorial.json") as Json).description.status = "rejected";
      }),
    );
    expect(targets.resolve(family("quiet-editorial"))).toBe("resolved");
    expect(targets.families.has("quiet-editorial")).toBe(true);
  });
});

describe("one resolution rule for the cross-file checks and the targets", () => {
  const variants: [string, Snapshot][] = [
    ["the golden library", goldenSnapshot()],
    [
      "a reference with errors",
      goldenSnapshot((files) => void files.set(`references/${A}.json`, "{")),
    ],
    [
      "pieces, families, directions and guardrails that are gone",
      goldenSnapshot((files) => {
        files.delete(`references/${D}.json`);
        files.delete("families/quiet-editorial.json");
        (files.get(`references/${A}.json`) as Json).pins.pop();
        const directions = files.get("projects/landing-redesign/directions.json") as Json;
        directions.directions[0].guardrails.push("gr-9z9z9z");
      }),
    ],
    [
      "guardrails.json with errors",
      goldenSnapshot((files) => void files.set("guardrails.json", "{")),
    ],
    ["references/ not listed", goldenSnapshot(undefined, { unlisted: ["references"] })],
  ];

  for (const [name, snapshot] of variants) {
    it(`every link has the state the targets give it: ${name}`, () => {
      const files = crossFilesOf(snapshot);
      const targets = buildTargets(files, 1, snapshot.unlistedFolders);
      const links: LinkEvent[] = [];
      crossFileIssues(files, {
        current: 1,
        sha256,
        unlistedFolders: snapshot.unlistedFolders,
        onLink: (link) => void links.push(link),
      });
      expect(links.length).toBeGreaterThan(0);
      for (const link of links) {
        expect(targets.resolve(link.to), `${link.file}${link.pointer}`).toBe(link.state);
        expect(targetFileOf(link.to)).toBe(link.targetFile);
      }
    });
  }

  it("is the rule the cross-file checks use: the states differ when another rule is passed in", () => {
    const snapshot = goldenSnapshot();
    const files = crossFilesOf(snapshot);
    const real = buildTargets(files, 1, []);
    const links: LinkEvent[] = [];
    crossFileIssues(files, {
      current: 1,
      sha256,
      targets: { ...real, resolve: () => "dangling" },
      onLink: (link) => void links.push(link),
    });
    expect(links.every((link) => link.state === "dangling")).toBe(true);
  });
});
