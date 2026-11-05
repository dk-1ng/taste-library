import { mkdir, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withTempDir } from "@tastelib/testkit";
import { describe, expect, it } from "vitest";
import { editJson, withGoldenCopy } from "../../test/support/golden.js";
import { TEST_REGISTRY } from "../../test/support/registry.js";
import { FORMAT_REGISTRY, type Issue, reportOf } from "../browser.js";
import { openLibrary } from "./open.js";

const A = "ref-20261101-a1b2c3";
const B = "ref-20261102-d4e5f6";
const C = "ref-20261103-g7h8j9";
const D = "ref-20261104-m2n3p4";

/** Opens the library and returns its issues; fails the test when it cannot be opened. */
async function issuesOf(library: string, registry = FORMAT_REGISTRY): Promise<Issue[]> {
  const opened = await openLibrary(library, { registry });
  if (!opened.ok) throw new Error(opened.message);
  const result = await opened.library.snapshot();
  if (!result.ok) throw new Error(result.message);
  return [...result.snapshot.issues];
}

/** The issues with one code, as `[severity, file, pointer]`. */
function pick(issues: readonly Issue[], code: string): [string, string | null, string | null][] {
  return issues
    .filter((issue) => issue.code === code)
    .map((issue) => [issue.severity, issue.file, issue.pointer]);
}

describe("opening a library", () => {
  it("is not a library without library.json", async () => {
    await withTempDir(async (dir) => {
      await mkdir(join(dir, "references"));
      const result = await openLibrary(dir);
      expect(result).toMatchObject({ ok: false, code: "not-a-library" });
      expect(JSON.stringify(result)).not.toContain(dir);
    });
  });

  it("cannot read a folder that does not exist", async () => {
    await withTempDir(async (dir) => {
      const result = await openLibrary(join(dir, "missing"));
      expect(result).toMatchObject({ ok: false, code: "unreadable-folder" });
      expect(JSON.stringify(result)).not.toContain(dir);
    });
  });

  it("cannot read a path that is a file", async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, "library.json"), "{}");
      expect(await openLibrary(join(dir, "library.json"))).toMatchObject({
        ok: false,
        code: "unreadable-folder",
      });
    });
  });

  it("reads again on every snapshot after the first", async () => {
    await withGoldenCopy(async (library) => {
      const opened = await openLibrary(library);
      if (!opened.ok) throw new Error(opened.message);
      const first = await opened.library.snapshot();
      await writeFile(join(library, "references", "notes.txt"), "x");
      const second = await opened.library.snapshot();
      if (!first.ok || !second.ok) throw new Error("not a library");
      expect(first.snapshot.issues).toEqual([]);
      expect(pick(second.snapshot.issues, "unexpected-file")).toEqual([
        ["warning", "references/notes.txt", null],
      ]);
    });
  });

  it("answers not-a-library when library.json disappears before a later snapshot", async () => {
    await withGoldenCopy(async (library) => {
      const opened = await openLibrary(library);
      if (!opened.ok) throw new Error(opened.message);
      await opened.library.snapshot();
      await rm(join(library, "library.json"));
      expect(await opened.library.snapshot()).toMatchObject({ ok: false, code: "not-a-library" });
    });
  });

  it("lists files sorted and keeps their exact bytes", async () => {
    await withGoldenCopy(async (library) => {
      const opened = await openLibrary(library);
      if (!opened.ok) throw new Error(opened.message);
      const result = await opened.library.snapshot();
      if (!result.ok) throw new Error(result.message);
      const paths = [...result.snapshot.files.keys()];
      expect(paths).toEqual([...paths].sort());
      expect(paths).toContain(`references/${B}.json`);
      const file = result.snapshot.files.get("library.json");
      expect(file).toMatchObject({ kind: "library", status: "valid", formatVersion: 1 });
      expect(file?.bytes).toBeInstanceOf(Uint8Array);
    });
  });

  it("ignores .tastelib/ and the other files at the top of the library", async () => {
    await withGoldenCopy(async (library) => {
      await mkdir(join(library, ".tastelib", "migration-backup"), { recursive: true });
      await writeFile(join(library, ".tastelib", "anything.txt"), "x");
      await writeFile(join(library, "README.md"), "# notes\n");
      await writeFile(join(library, ".gitignore"), ".tastelib/\n");
      await writeFile(join(library, ".glossary.json.tmp-12345678"), "x"); // top level: ignored (docs/design.md section 4)
      expect(await issuesOf(library)).toEqual([]);
    });
  });

  it("reports an unreadable file and keeps going", async () => {
    await withGoldenCopy(async (library) => {
      await rm(join(library, "glossary.json"));
      await mkdir(join(library, "glossary.json")); // a folder where the file should be
      const issues = await issuesOf(library);
      expect(pick(issues, "unreadable-file")).toEqual([["error", "glossary.json", null]]);
    });
  });

  it("treats a symbolic link that leads to a folder as a folder, so it is unexpected in references/", async () => {
    await withGoldenCopy(async (library) => {
      try {
        await symlink(
          join(library, "families"),
          join(library, "references", "ref-20261105-zzzzzz.json"),
          "junction",
        );
      } catch {
        return; // creating links needs extra rights on some Windows setups
      }
      const issues = await issuesOf(library);
      expect(pick(issues, "unexpected-file")).toEqual([
        ["warning", "references/ref-20261105-zzzzzz.json", null],
      ]);
    });
  });
});

/** A `readdir` that fails with an errno code for the given folders (relative to the library). */
function failingReaddir(library: string, failures: Record<string, string>): typeof readdir {
  return (async (path: string, options: never) => {
    for (const [folder, code] of Object.entries(failures)) {
      if (path === join(library, ...folder.split("/"))) {
        throw Object.assign(new Error("injected"), { code });
      }
    }
    return readdir(path, options);
  }) as typeof readdir;
}

describe("folders that cannot be listed", () => {
  it("makes links into a folder that failed to list unresolved, not dangling, and reports the folder", async () => {
    await withGoldenCopy(async (library) => {
      const opened = await openLibrary(library, {
        readdir: failingReaddir(library, {
          references: "EACCES",
          "projects/landing-redesign": "EIO",
        }),
      });
      if (!opened.ok) throw new Error(opened.message);
      const result = await opened.library.snapshot();
      if (!result.ok) throw new Error(result.message);
      const issues = result.snapshot.issues;
      expect(pick(issues, "unreadable-file")).toEqual([
        ["error", "projects/landing-redesign", null],
        ["error", "references", null],
      ]);
      // Every reference, the project and its directions are unknown, so nothing dangles.
      expect(pick(issues, "dangling-link")).toEqual([]);
      expect(JSON.stringify(issues)).not.toContain(library);
    });
  });

  it("treats a symbolic link that cannot be followed where a format folder belongs as a folder that cannot be listed", async () => {
    await withGoldenCopy(async (library) => {
      try {
        await rm(join(library, "references"), { recursive: true });
        await symlink(join(library, "nowhere"), join(library, "references"));
        await rm(join(library, "projects", "internal-dashboard"), { recursive: true });
        await symlink(join(library, "nowhere"), join(library, "projects", "internal-dashboard"));
      } catch {
        return; // creating links needs extra rights on some Windows setups
      }
      const issues = await issuesOf(library);
      expect(pick(issues, "unreadable-file")).toEqual([
        ["error", "projects/internal-dashboard", null],
        ["error", "references", null],
      ]);
      expect(issues.find((i) => i.file === "references")?.message).toContain("(ENOENT)");
      expect(pick(issues, "dangling-link")).toEqual([]);
      expect(pick(issues, "unexpected-file")).toEqual([]);
    });
  });

  it("treats a folder that disappeared since its parent was listed as deleted", async () => {
    await withGoldenCopy(async (library) => {
      const opened = await openLibrary(library, {
        readdir: failingReaddir(library, {
          "projects/internal-dashboard": "ENOENT",
          families: "ENOTDIR",
        }),
      });
      if (!opened.ok) throw new Error(opened.message);
      const result = await opened.library.snapshot();
      if (!result.ok) throw new Error(result.message);
      expect(pick(result.snapshot.issues, "unreadable-file")).toEqual([]);
      // Deleted means absent: the directions of the project that exist still link to families that are gone.
      expect(pick(result.snapshot.issues, "dangling-link")).toEqual([
        ["warning", "projects/landing-redesign/directions.json", "/directions/0/family"],
      ]);
    });
  });

  it("reports a symbolic link that cannot be followed where a file belongs as unreadable-file", async () => {
    await withGoldenCopy(async (library) => {
      try {
        await symlink(
          join(library, "nowhere.json"),
          join(library, "references", "ref-20261105-zzzzzz.json"),
        );
        await symlink(join(library, "nowhere.txt"), join(library, "references", "notes.txt"));
      } catch {
        return; // creating links needs extra rights on some Windows setups
      }
      const issues = await issuesOf(library);
      expect(pick(issues, "unreadable-file")).toEqual([
        ["error", "references/ref-20261105-zzzzzz.json", null],
      ]);
      // A link with a name the format does not know is unexpected, as any other file.
      expect(pick(issues, "unexpected-file")).toEqual([["warning", "references/notes.txt", null]]);
    });
  });
});

describe("folder codes", () => {
  it("name-mismatch: a reference, a family and a project that hold another identifier than their name", async () => {
    await withGoldenCopy(async (library) => {
      await editJson(library, `references/${B}.json`, (v) => {
        v.id = "ref-20261102-d4e5f7";
      });
      await editJson(library, "families/dense-dashboards.json", (v) => {
        v.slug = "other-name";
      });
      await editJson(library, "projects/internal-dashboard/project.json", (v) => {
        v.slug = "another-project";
      });
      const issues = await issuesOf(library);
      expect(pick(issues, "name-mismatch")).toEqual([
        ["error", "families/dense-dashboards.json", "/slug"],
        ["error", "projects/internal-dashboard/project.json", "/slug"],
        ["error", `references/${B}.json`, "/id"],
      ]);
      // A file with an error is invalid, so the checks across files leave it out.
      expect(issues.filter((i) => i.severity === "error").map((i) => i.code)).toEqual([
        "name-mismatch",
        "name-mismatch",
        "name-mismatch",
        "schema-violation", // the media paths of the renamed reference name the old id
      ]);
    });
  });

  it("name-mismatch: is not reported again when the identifier breaks its own rule", async () => {
    await withGoldenCopy(async (library) => {
      await editJson(library, "families/dense-dashboards.json", (v) => {
        v.slug = "Not A Slug";
      });
      const issues = await issuesOf(library);
      expect(pick(issues, "name-mismatch")).toEqual([]);
      expect(pick(issues, "schema-violation")).toEqual([
        ["error", "families/dense-dashboards.json", "/slug"],
      ]);
    });
  });

  it("unexpected-file: any other file or folder inside a format folder", async () => {
    await withGoldenCopy(async (library) => {
      await writeFile(join(library, "references", "notes.txt"), "x");
      await writeFile(join(library, "references", "notes.JSON"), "{}");
      await mkdir(join(library, "families", "nested"));
      await writeFile(join(library, "projects", "loose.json"), "{}");
      await writeFile(join(library, "projects", "landing-redesign", "extra.json"), "{}");
      await mkdir(join(library, "projects", "landing-redesign", "deeper"));
      const issues = await issuesOf(library);
      expect(pick(issues, "unexpected-file")).toEqual([
        ["warning", "families/nested", null],
        ["warning", "projects/landing-redesign/deeper", null],
        ["warning", "projects/landing-redesign/extra.json", null],
        ["warning", "projects/loose.json", null],
        ["warning", "references/notes.JSON", null],
        ["warning", "references/notes.txt", null],
      ]);
      expect(issues.every((issue) => issue.severity === "warning")).toBe(true);
    });
  });

  it("unexpected-file: reports a name in Unicode NFC even when the file system holds another form", async () => {
    await withGoldenCopy(async (library) => {
      const nfc = "ímagem-é.txt";
      await writeFile(join(library, "references", nfc.normalize("NFD")), "x");
      const issues = await issuesOf(library);
      expect(pick(issues, "unexpected-file")).toEqual([["warning", `references/${nfc}`, null]]);
    });
  });

  it("leftover-temp-file: .<name>.tmp-<random> inside a format folder, not at the top", async () => {
    await withGoldenCopy(async (library) => {
      await writeFile(join(library, "references", `.${A}.json.tmp-0a1b2c3d`), "{");
      await writeFile(join(library, "families", ".quiet-editorial.json.tmp-zzzzzzzz"), "{"); // "z" is valid, "u" is not
      await writeFile(
        join(library, "projects", "landing-redesign", ".directions.json.tmp-k3m5n7p9"),
        "{",
      );
      await writeFile(join(library, ".guardrails.json.tmp-0a1b2c3d"), "{");
      await writeFile(join(library, "references", `.${A}.json.tmp-0u1b2c3d`), "{"); // not Crockford: unexpected
      const issues = await issuesOf(library);
      expect(pick(issues, "leftover-temp-file")).toEqual([
        ["warning", "families/.quiet-editorial.json.tmp-zzzzzzzz", null],
        ["warning", "projects/landing-redesign/.directions.json.tmp-k3m5n7p9", null],
        ["warning", `references/.${A}.json.tmp-0a1b2c3d`, null],
      ]);
      expect(pick(issues, "unexpected-file")).toEqual([
        ["warning", `references/.${A}.json.tmp-0u1b2c3d`, null],
      ]);
    });
  });
});

describe("version codes", () => {
  it("newer-format: the file is not checked further, and a write would be refused", async () => {
    await withGoldenCopy(async (library) => {
      await editJson(library, "families/dense-dashboards.json", (v) => {
        v.formatVersion = 2;
        v.unknownField = true; // would be a schema-violation at version 1
        delete v.slug;
      });
      const opened = await openLibrary(library);
      if (!opened.ok) throw new Error(opened.message);
      const result = await opened.library.snapshot();
      if (!result.ok) throw new Error(result.message);
      expect(pick(result.snapshot.issues, "newer-format")).toEqual([
        ["error", "families/dense-dashboards.json", "/formatVersion"],
      ]);
      expect(
        result.snapshot.issues.filter((i) => i.file === "families/dense-dashboards.json"),
      ).toHaveLength(1);
      expect(result.snapshot.files.get("families/dense-dashboards.json")).toMatchObject({
        status: "newer",
        formatVersion: 2,
        value: null,
      });
      // It is not a mixed library either: a file the tool cannot read is not compared.
      expect(pick(result.snapshot.issues, "mixed-format-versions")).toEqual([]);
    });
  });

  it("newer-format: library.json above the supported version is reported and gives the library's version", async () => {
    await withGoldenCopy(async (library) => {
      await editJson(library, "library.json", (v) => {
        v.formatVersion = 7;
      });
      const opened = await openLibrary(library);
      if (!opened.ok) throw new Error(opened.message);
      const result = await opened.library.snapshot();
      if (!result.ok) throw new Error(result.message);
      expect(pick(result.snapshot.issues, "newer-format")).toEqual([
        ["error", "library.json", "/formatVersion"],
      ]);
      expect(result.snapshot.formatVersion).toBe(7);
      expect(reportOf(FORMAT_REGISTRY, result.snapshot).libraryFormatVersion).toBe(7);
    });
  });

  it("mixed-format-versions: a file whose version differs from library.json", async () => {
    await withGoldenCopy(async (library) => {
      await editJson(library, "library.json", (v) => {
        v.formatVersion = 2;
      });
      const issues = await issuesOf(library, TEST_REGISTRY);
      const mixed = pick(issues, "mixed-format-versions");
      // Every other file is still at version 1.
      expect(mixed).toHaveLength(12);
      expect(mixed).toContainEqual(["warning", `references/${A}.json`, "/formatVersion"]);
      expect(
        mixed.every(
          ([severity, , pointer]) => severity === "warning" && pointer === "/formatVersion",
        ),
      ).toBe(true);
      expect(pick(issues, "needs-migration")).toEqual([]);
      // Files at an older version are checked against the schemas of that version, and links are not followed.
      expect(issues.filter((i) => i.severity === "error")).toEqual([]);
      expect(pick(issues, "dangling-link")).toEqual([]);
    });
  });

  it("mixed-format-versions: one file at the library's version and the others older", async () => {
    await withGoldenCopy(async (library) => {
      await editJson(library, "families/dense-dashboards.json", (v) => {
        v.formatVersion = 2;
      });
      const issues = await issuesOf(library, TEST_REGISTRY);
      // library.json is at 1, so only the version 2 file differs.
      expect(pick(issues, "mixed-format-versions")).toEqual([
        ["warning", "families/dense-dashboards.json", "/formatVersion"],
      ]);
      expect(pick(issues, "needs-migration")).toEqual([["info", null, null]]);
    });
  });

  it("needs-migration: an older library is reported once, for the library as a whole", async () => {
    await withGoldenCopy(async (library) => {
      const issues = await issuesOf(library, TEST_REGISTRY);
      expect(pick(issues, "needs-migration")).toEqual([["info", null, null]]);
      expect(pick(issues, "mixed-format-versions")).toEqual([]);
      expect(issues.filter((i) => i.severity !== "info")).toEqual([]);
    });
  });
});

describe("cross-file codes", () => {
  it("dangling-link: a piece of a reference that does not exist is a warning in every kind of file that links", async () => {
    await withGoldenCopy(async (library) => {
      await rm(join(library, "references", `${C}.json`));
      const issues = await issuesOf(library);
      expect(pick(issues, "dangling-link")).toEqual([
        ["warning", "families/quiet-editorial.json", "/members/2/target"],
        ["warning", "families/quiet-editorial.json", "/members/3/target"],
        ["warning", "glossary.json", "/terms/2/pieces/0"],
        ["warning", "guardrails.json", "/guardrails/1/sources/0"],
        ["warning", "projects/landing-redesign/directions.json", "/directions/0/pieces/1"],
      ]);
      const dangling = issues.find(
        (i) => i.code === "dangling-link" && i.file === "families/quiet-editorial.json",
      );
      expect(dangling?.message).toBe(`members[2].target: piece ${C}#p0 does not exist.`);
      // A link that points to nothing is a warning, never an error.
      expect(issues.filter((i) => i.severity === "error")).toEqual([]);
    });
  });

  it("dangling-link: a missing piece in a reference that exists (taste profile evidence)", async () => {
    await withGoldenCopy(async (library) => {
      await editJson(library, "taste-profile.json", (v) => {
        v.statements[0].evidence[1] = `${A}#p9`;
      });
      const issues = await issuesOf(library);
      expect(pick(issues, "dangling-link")).toEqual([
        ["warning", "taste-profile.json", "/statements/0/evidence/1"],
      ]);
      expect(issues.filter((i) => i.severity === "error")).toEqual([]);
    });
  });

  it("dangling-link: result.project and result.direction", async () => {
    await withGoldenCopy(async (library) => {
      await editJson(library, `references/${D}.json`, (v) => {
        v.result = { project: "ghost-project", direction: "d1" };
      });
      let issues = await issuesOf(library);
      expect(pick(issues, "dangling-link")).toEqual([
        ["warning", `references/${D}.json`, "/result/direction"],
        ["warning", `references/${D}.json`, "/result/project"],
      ]);
      await editJson(library, `references/${D}.json`, (v) => {
        v.result = { project: "landing-redesign", direction: "d9" };
      });
      issues = await issuesOf(library);
      expect(pick(issues, "dangling-link")).toEqual([
        ["warning", `references/${D}.json`, "/result/direction"],
      ]);
      await editJson(library, `references/${D}.json`, (v) => {
        v.result = { project: "internal-dashboard", direction: null };
      });
      expect(pick(await issuesOf(library), "dangling-link")).toEqual([]);
      // A project with no directions.json has no direction d1.
      await editJson(library, `references/${D}.json`, (v) => {
        v.result = { project: "internal-dashboard", direction: "d1" };
      });
      expect(pick(await issuesOf(library), "dangling-link")).toEqual([
        ["warning", `references/${D}.json`, "/result/direction"],
      ]);
    });
  });

  it("dangling-link: direction.family and direction.guardrails", async () => {
    await withGoldenCopy(async (library) => {
      await editJson(library, "projects/landing-redesign/directions.json", (v) => {
        v.directions[0].family = "ghost-family";
        v.directions[0].guardrails = ["gr-3k7m2q", "gr-zzzzzz"];
      });
      const issues = await issuesOf(library);
      expect(pick(issues, "dangling-link")).toEqual([
        ["warning", "projects/landing-redesign/directions.json", "/directions/0/family"],
        ["warning", "projects/landing-redesign/directions.json", "/directions/0/guardrails/1"],
      ]);
    });
  });

  it("dangling-link: guardrails.json that does not exist makes every guardrail link dangle", async () => {
    await withGoldenCopy(async (library) => {
      await rm(join(library, "guardrails.json"));
      const issues = await issuesOf(library);
      expect(pick(issues, "dangling-link")).toEqual([
        ["warning", "projects/landing-redesign/directions.json", "/directions/0/guardrails/0"],
      ]);
    });
  });

  it("a link into a file with errors is unresolved: no dangling-link, and the broken file has its own error", async () => {
    await withGoldenCopy(async (library) => {
      await writeFile(join(library, "references", `${A}.json`), "{ not json");
      await writeFile(join(library, "families", "quiet-editorial.json"), "{ not json");
      await writeFile(join(library, "guardrails.json"), "{ not json");
      await writeFile(
        join(library, "projects", "landing-redesign", "directions.json"),
        "{ not json",
      );
      const issues = await issuesOf(library);
      expect(pick(issues, "dangling-link")).toEqual([]);
      expect(issues.filter((i) => i.severity === "error").map((i) => [i.code, i.file])).toEqual([
        ["invalid-json", "families/quiet-editorial.json"],
        ["invalid-json", "guardrails.json"],
        ["invalid-json", "projects/landing-redesign/directions.json"],
        ["invalid-json", `references/${A}.json`],
      ]);
    });
  });

  it("a link into a file that is not a reference of that name still dangles when the file is absent", async () => {
    await withGoldenCopy(async (library) => {
      await rename(
        join(library, "references", `${B}.json`),
        join(library, "references", "ref-20261102-d4e5f8.json"),
      );
      await editJson(library, "glossary.json", (v) => {
        v.terms[0].pieces = [`${B}#p0`];
      });
      const issues = await issuesOf(library);
      expect(pick(issues, "dangling-link")).toEqual([
        ["warning", "glossary.json", "/terms/0/pieces/0"],
      ]);
      expect(pick(issues, "name-mismatch")).toEqual([
        ["error", "references/ref-20261102-d4e5f8.json", "/id"],
      ]);
    });
  });

  it("proposal-stale: a note that changed after a proposal that is to-review or accepted", async () => {
    await withGoldenCopy(async (library) => {
      await editJson(library, `references/${A}.json`, (v) => {
        v.note = "Calm, dense and a little warm.";
        v.pins[1].note = "Too loud, the banner shouts at me.";
      });
      // A corrected or rejected proposal is not stale: the user already decided.
      await editJson(library, `references/${C}.json`, (v) => {
        v.note = "Changed after the correction.";
        v.pins[0].note = "Changed after the rejection.";
      });
      const issues = await issuesOf(library);
      expect(pick(issues, "proposal-stale")).toEqual([
        ["warning", `references/${A}.json`, "/interpretations/p0/inputSha256"],
        ["warning", `references/${A}.json`, "/interpretations/p2/inputSha256"],
      ]);
      expect(issues.filter((i) => i.severity === "error")).toEqual([]);
    });
  });

  it("proposal-stale: an agent proposal over a note of non-ASCII text is compared on its UTF-8 bytes", async () => {
    await withGoldenCopy(async (library) => {
      await editJson(library, `references/${D}.json`, (v) => {
        v.note = "Versão gerada — ação 日本語";
      });
      const issues = await issuesOf(library);
      expect(pick(issues, "proposal-stale")).toEqual([
        ["warning", `references/${D}.json`, "/interpretations/p0/inputSha256"],
      ]);
    });
  });

  it("duplicate-term: two terms that compare equal without case or Unicode form, reported on the later one", async () => {
    await withGoldenCopy(async (library) => {
      await editJson(library, "glossary.json", (v) => {
        v.terms[1].entry.proposal.term = "QUIET DENSITY";
        v.terms[2].entry.correction.term = "Café";
        v.terms.push({
          id: "term-zz1122",
          createdAt: "2026-11-03T12:00:00.000Z",
          updatedAt: "2026-11-03T12:00:00.000Z",
          pieces: [],
          entry: {
            origin: "user",
            content: { term: "café", definition: "Same as the corrected one." },
            writtenAt: "2026-11-03T12:00:00.000Z",
          },
        });
      });
      const issues = await issuesOf(library);
      expect(pick(issues, "duplicate-term")).toEqual([
        ["warning", "glossary.json", "/terms/1/entry/proposal/term"],
        ["warning", "glossary.json", "/terms/4/entry/content/term"],
      ]);
      // The rejected term "quiet density" never counted, and the glossary is still valid.
      expect(issues.filter((i) => i.severity === "error")).toEqual([]);
    });
  });
});

describe("the report", () => {
  it("is sorted by file (null first), pointer (null first) and code, with counts and no absolute path", async () => {
    await withGoldenCopy(async (library, base) => {
      await rm(join(library, "references", `${C}.json`));
      await writeFile(join(library, "references", "notes.txt"), "x");
      await editJson(library, "library.json", (v) => {
        v.name = 42;
      });
      const opened = await openLibrary(library);
      if (!opened.ok) throw new Error(opened.message);
      const result = await opened.library.snapshot();
      if (!result.ok) throw new Error(result.message);
      const report = reportOf(FORMAT_REGISTRY, result.snapshot);
      expect(Object.keys(report)).toEqual([
        "reportVersion",
        "libraryFormatVersion",
        "supportedFormatVersion",
        "counts",
        "issues",
      ]);
      expect(report).toMatchObject({
        reportVersion: 1,
        libraryFormatVersion: 1,
        supportedFormatVersion: 1,
      });
      expect(report.counts).toEqual({ error: 1, warning: 6, info: 1 });
      expect(report.issues.map((i) => [i.file, i.pointer, i.code])).toEqual([
        [null, null, "media-not-checked"],
        ["families/quiet-editorial.json", "/members/2/target", "dangling-link"],
        ["families/quiet-editorial.json", "/members/3/target", "dangling-link"],
        ["glossary.json", "/terms/2/pieces/0", "dangling-link"],
        ["guardrails.json", "/guardrails/1/sources/0", "dangling-link"],
        ["library.json", "/name", "schema-violation"],
        ["projects/landing-redesign/directions.json", "/directions/0/pieces/1", "dangling-link"],
        ["references/notes.txt", null, "unexpected-file"],
      ]);
      const text = JSON.stringify(report);
      expect(text).not.toContain(base);
      expect(text).not.toContain(JSON.stringify(base).slice(1, -1));
      expect(text).not.toContain("Usuário");
      for (const issue of report.issues) expect(issue.message).toMatch(/^[\x20-\x7e]+$/);
    });
  });

  it("gives a null library version when library.json cannot be read", async () => {
    await withGoldenCopy(async (library) => {
      await writeFile(join(library, "library.json"), "{ not json");
      const opened = await openLibrary(library);
      if (!opened.ok) throw new Error(opened.message);
      const result = await opened.library.snapshot();
      if (!result.ok) throw new Error(result.message);
      expect(reportOf(FORMAT_REGISTRY, result.snapshot).libraryFormatVersion).toBeNull();
      // With the library's version unknown, no file is compared with it.
      expect(pick(result.snapshot.issues, "mixed-format-versions")).toEqual([]);
    });
  });

  it("takes the media issues from the caller and reports media-not-checked only without them", async () => {
    await withGoldenCopy(async (library) => {
      const opened = await openLibrary(library);
      if (!opened.ok) throw new Error(opened.message);
      const result = await opened.library.snapshot();
      if (!result.ok) throw new Error(result.message);
      expect(reportOf(FORMAT_REGISTRY, result.snapshot).issues.map((i) => i.code)).toEqual([
        "media-not-checked",
      ]);
      expect(reportOf(FORMAT_REGISTRY, result.snapshot, []).issues).toEqual([]);
    });
  });
});
