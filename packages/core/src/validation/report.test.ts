import { describe, expect, it } from "vitest";
import { type Issue, makeIssue } from "./issue.js";
import { buildReport, compareIssues, countIssues, mediaNotChecked, sortIssues } from "./report.js";

const issue = (
  code: Parameters<typeof makeIssue>[0],
  file: string | null,
  pointer: string | null,
): Issue => makeIssue(code, file, pointer, "m");

describe("the report", () => {
  it("sorts by file with null first, then pointer with null first, then code", () => {
    const sorted = sortIssues([
      issue("dangling-link", "b.json", "/a"),
      issue("not-canonical", "a.json", null),
      issue("schema-violation", "a.json", "/z"),
      issue("duplicate-key", "a.json", "/z"),
      issue("media-not-checked", null, null),
      issue("unexpected-file", "a.json", "/a"),
      issue("needs-migration", null, "/x"),
    ]);
    expect(sorted.map((i) => [i.file, i.pointer, i.code])).toEqual([
      [null, null, "media-not-checked"],
      [null, "/x", "needs-migration"],
      ["a.json", null, "not-canonical"],
      ["a.json", "/a", "unexpected-file"],
      ["a.json", "/z", "duplicate-key"],
      ["a.json", "/z", "schema-violation"],
      ["b.json", "/a", "dangling-link"],
    ]);
  });

  it("orders by code units, never by locale, and leaves the input alone", () => {
    const input = [
      issue("not-canonical", "é.json", null),
      issue("not-canonical", "z.json", null),
      issue("not-canonical", "Z.json", null),
    ];
    expect(sortIssues(input).map((i) => i.file)).toEqual(["Z.json", "z.json", "é.json"]);
    expect(input.map((i) => i.file)).toEqual(["é.json", "z.json", "Z.json"]);
  });

  it("settles a tie on the message, so the order never depends on how issues were found", () => {
    const a = makeIssue("dangling-link", "f.json", "/p", "a");
    const b = makeIssue("dangling-link", "f.json", "/p", "b");
    expect(compareIssues(a, b)).toBeLessThan(0);
    expect(compareIssues(b, a)).toBeGreaterThan(0);
    expect(compareIssues(a, a)).toBe(0);
  });

  it("counts by severity", () => {
    expect(
      countIssues([
        issue("invalid-json", "a", null),
        issue("not-canonical", "a", null),
        issue("not-canonical", "b", null),
        issue("needs-migration", null, null),
      ]),
    ).toEqual({
      error: 1,
      warning: 2,
      info: 1,
    });
  });

  it("has the shape and key order of format-spec §16.3", () => {
    const report = buildReport({
      libraryFormatVersion: null,
      supportedFormatVersion: 1,
      issues: [mediaNotChecked()],
    });
    expect(JSON.parse(JSON.stringify(report))).toEqual({
      reportVersion: 1,
      libraryFormatVersion: null,
      supportedFormatVersion: 1,
      counts: { error: 0, warning: 0, info: 1 },
      issues: [
        {
          severity: "info",
          code: "media-not-checked",
          file: null,
          pointer: null,
          message: "No media folder is set on this computer, so media files were not checked.",
        },
      ],
    });
    expect(Object.keys(report)).toEqual([
      "reportVersion",
      "libraryFormatVersion",
      "supportedFormatVersion",
      "counts",
      "issues",
    ]);
    expect(Object.keys(report.counts)).toEqual(["error", "warning", "info"]);
    expect(Object.keys(report.issues[0] as Issue)).toEqual([
      "severity",
      "code",
      "file",
      "pointer",
      "message",
    ]);
  });
});
