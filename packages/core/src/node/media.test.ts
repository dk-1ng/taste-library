import { chmod, mkdir, readFile, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makePng, withTempDir } from "@tastelib/testkit";
import { describe, expect, it } from "vitest";
import { v1ToV2 } from "../../test/migrations/v1-to-v2.js";
import { withGoldenCopy, writeGoldenMedia } from "../../test/support/golden.js";
import { TEST_REGISTRY } from "../../test/support/registry.js";
import { type Issue, type LibraryValues, type MigrationStep, reportOf } from "../browser.js";
import { FORMAT_REGISTRY, type FormatRegistry } from "../format.js";
import { checkMedia } from "./media.js";
import { resolveMediaPath } from "./media-path.js";
import { openLibrary } from "./open.js";

const A = "ref-20261101-a1b2c3";

async function snapshotOf(library: string) {
  const opened = await openLibrary(library);
  if (!opened.ok) throw new Error(opened.message);
  const result = await opened.library.snapshot();
  if (!result.ok) throw new Error(result.message);
  return result.snapshot;
}

async function mediaIssues(library: string, media: string, checksums = false): Promise<Issue[]> {
  return checkMedia(await snapshotOf(library), media, { checksums });
}

const brief = (issues: readonly Issue[], code: string): [string, string | null][] =>
  issues.filter((i) => i.code === code).map((i) => [i.severity, i.file]);

/** Runs `fn` with the golden library and its generated media folder, both under a non-ASCII path. */
async function withMedia<T>(
  fn: (library: string, media: string, files: string[]) => Promise<T>,
): Promise<T> {
  return withGoldenCopy(async (library, base) => {
    const media = join(base, "mídia");
    const files = await writeGoldenMedia(library, media);
    return fn(library, media, files);
  });
}

describe("checkMedia", () => {
  it("finds nothing wrong with a complete media folder, with and without checksums", async () => {
    await withMedia(async (library, media) => {
      expect(await mediaIssues(library, media)).toEqual([]);
      expect(await mediaIssues(library, media, true)).toEqual([]);
    });
  });

  it("reports a media file that has not arrived as awaiting-sync (info), and the report still passes", async () => {
    await withMedia(async (library, media, files) => {
      const gone = files[0] as string;
      await rm(join(media, ...gone.split("/")));
      const issues = await mediaIssues(library, media);
      expect(brief(issues, "awaiting-sync")).toEqual([["info", `media:${gone}`]]);
      const report = reportOf(FORMAT_REGISTRY, await snapshotOf(library), issues);
      expect(report.counts.error).toBe(0);
      expect(report.counts.warning).toBe(0);
    });
  });

  it("reports a different size as media-mismatch (warning)", async () => {
    await withMedia(async (library, media, files) => {
      const file = files[0] as string;
      await truncate(join(media, ...file.split("/")), 10);
      expect(brief(await mediaIssues(library, media), "media-mismatch")).toEqual([
        ["warning", `media:${file}`],
      ]);
    });
  });

  it("compares checksums only with the option", async () => {
    await withMedia(async (library, media, files) => {
      const file = files[0] as string;
      const path = join(media, ...file.split("/"));
      const bytes = await readFile(path);
      bytes[bytes.length - 1] = (bytes[bytes.length - 1] as number) ^ 0xff; // same size
      await writeFile(path, bytes);
      expect(brief(await mediaIssues(library, media), "media-mismatch")).toEqual([]);
      expect(brief(await mediaIssues(library, media, true), "media-mismatch")).toEqual([
        ["warning", `media:${file}`],
      ]);
    });
  });

  it("never rewrites a file", async () => {
    await withMedia(async (library, media, files) => {
      const path = join(media, ...(files[0] as string).split("/"));
      await writeFile(path, makePng(4, 4, 1));
      const before = await readFile(path);
      await mediaIssues(library, media, true);
      expect(await readFile(path)).toEqual(before);
    });
  });

  it("reports a file in a reference folder that no reference lists as orphan-media (warning)", async () => {
    await withMedia(async (library, media) => {
      await writeFile(join(media, A, "m99.png"), makePng(2, 2, 3));
      await mkdir(join(media, "ref-20269999-zzzzzz"));
      await writeFile(join(media, "ref-20269999-zzzzzz", "m1.png"), makePng(2, 2, 3));
      await writeFile(join(media, A, ".DS_Store"), "finder");
      await writeFile(join(media, A, "Thumbs.db"), "windows");
      await writeFile(join(media, "notes.txt"), "not in a reference folder");
      expect(brief(await mediaIssues(library, media), "orphan-media")).toEqual([
        ["warning", `media:${A}/m99.png`],
        ["warning", "media:ref-20269999-zzzzzz/m1.png"],
      ]);
    });
  });

  it("does not call a file an orphan when its reference cannot be read", async () => {
    await withMedia(async (library, media) => {
      await writeFile(join(library, "references", `${A}.json`), "{");
      await writeFile(join(media, A, "m99.png"), makePng(2, 2, 3));
      const issues = await mediaIssues(library, media);
      expect(brief(issues, "orphan-media")).toEqual([]);
    });
  });

  it.skipIf(process.platform === "win32")(
    "reports a FIFO at a media path without hanging",
    async () => {
      const { execFileSync } = await import("node:child_process");
      await withMedia(async (library, media, files) => {
        const path = join(media, ...(files[0] as string).split("/"));
        await rm(path);
        execFileSync("mkfifo", [path]);
        expect(brief(await mediaIssues(library, media), "media-mismatch")).toEqual([
          ["warning", `media:${files[0]}`],
        ]);
      });
    },
  );

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "reports no orphan when references/ cannot be listed",
    async () => {
      await withMedia(async (library, media) => {
        await chmod(join(library, "references"), 0o000);
        try {
          expect(brief(await mediaIssues(library, media), "orphan-media")).toEqual([]);
        } finally {
          await chmod(join(library, "references"), 0o755);
        }
      });
    },
  );

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0).each([0o000, 0o600])(
    "reports a media folder without permission (mode %o) once",
    async (mode) => {
      await withMedia(async (library, media) => {
        await chmod(media, mode);
        try {
          const issues = await mediaIssues(library, media);
          expect(issues.map((i) => [i.code, i.file])).toEqual([["unreadable-file", null]]);
        } finally {
          await chmod(media, 0o755);
        }
      });
    },
  );

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "reports a listed file that cannot be read as unreadable-file at its media path",
    async () => {
      await withMedia(async (library, media, files) => {
        const file = files[0] as string;
        const path = join(media, ...file.split("/"));
        await chmod(path, 0o000);
        try {
          expect(brief(await mediaIssues(library, media), "unreadable-file")).toEqual([
            ["error", `media:${file}`],
          ]);
        } finally {
          await chmod(path, 0o644);
        }
      });
    },
  );

  it("treats a non-integer marker version as a schema violation, not a newer format", async () => {
    await withMedia(async (library, media) => {
      await writeFile(
        join(media, "tastelib-media.json"),
        '{"formatVersion":1.5,"libraryId":"lib-9k3m7q2x4a"}',
      );
      const issues = await mediaIssues(library, media);
      expect(brief(issues, "newer-format")).toEqual([]);
      expect(brief(issues, "schema-violation")).toHaveLength(1);
    });
  });

  describe("the marker", () => {
    it("warns when it is missing, and still checks the files", async () => {
      await withMedia(async (library, media, files) => {
        await rm(join(media, "tastelib-media.json"));
        await rm(join(media, ...(files[0] as string).split("/")));
        const issues = await mediaIssues(library, media);
        expect(brief(issues, "media-marker-missing")).toEqual([
          ["warning", "media:tastelib-media.json"],
        ]);
        expect(brief(issues, "awaiting-sync")).toHaveLength(1);
      });
    });

    it("is an error for another library, and skips the file checks", async () => {
      await withMedia(async (library, media, files) => {
        await writeFile(
          join(media, "tastelib-media.json"),
          JSON.stringify({ formatVersion: 1, libraryId: "lib-0000000000" }),
        );
        await rm(join(media, ...(files[0] as string).split("/")));
        const issues = await mediaIssues(library, media);
        expect(brief(issues, "media-folder-mismatch")).toEqual([
          ["error", "media:tastelib-media.json"],
        ]);
        expect(issues.map((i) => i.code)).toEqual(["media-folder-mismatch"]);
      });
    });

    it("is newer-format for a newer version, naming the marker", async () => {
      await withMedia(async (library, media) => {
        await writeFile(
          join(media, "tastelib-media.json"),
          JSON.stringify({ formatVersion: 2, libraryId: "x" }),
        );
        const opened = await openLibrary(library);
        if (!opened.ok) throw new Error(opened.message);
        const snap = await opened.library.snapshot();
        if (!snap.ok) throw new Error(snap.message);
        expect(brief(await checkMedia(snap.snapshot, media), "newer-format")).toEqual([
          ["error", "media:tastelib-media.json"],
        ]);
      });
    });

    it("names the marker in its schema issues", async () => {
      await withMedia(async (library, media) => {
        await writeFile(join(media, "tastelib-media.json"), JSON.stringify({ formatVersion: 1 }));
        const issues = await mediaIssues(library, media);
        expect(brief(issues, "schema-violation")).toEqual([["error", "media:tastelib-media.json"]]);
        await writeFile(join(media, "tastelib-media.json"), "{");
        expect(brief(await mediaIssues(library, media), "invalid-json")).toEqual([
          ["error", "media:tastelib-media.json"],
        ]);
      });
    });
  });

  it("works with a registry that has a newer version", async () => {
    await withMedia(async (library, media) => {
      expect(
        await checkMedia(await snapshotOf(library), media, { registry: TEST_REGISTRY }),
      ).toEqual([]);
    });
  });

  it("reads the media a reference lists from the migrated view of an older library", async () => {
    await withMedia(async (library, media, files) => {
      // A step that changes the size the first media item of A records: only the migrated view has it.
      const step: MigrationStep = (input: LibraryValues) => {
        const out = new Map(v1ToV2(input));
        const reference = structuredClone(out.get(`references/${A}.json`)) as {
          media: { file: string; bytes: number }[];
        };
        const first = reference.media[0];
        if (first === undefined) throw new Error("no media in the reference");
        first.bytes += 1;
        out.set(`references/${A}.json`, reference);
        return out;
      };
      const registry: FormatRegistry = { ...TEST_REGISTRY, steps: { 1: step } };
      const opened = await openLibrary(library, { registry });
      if (!opened.ok) throw new Error(opened.message);
      const result = await opened.library.snapshot();
      if (!result.ok) throw new Error(result.message);
      expect(result.snapshot.migrated).not.toBeNull();
      const file = files.find((path) => path.startsWith(`${A}/`));
      expect(
        brief(await checkMedia(result.snapshot, media, { registry }), "media-mismatch"),
      ).toEqual([["warning", `media:${file}`]]);
    });
  });

  it("reports an unreadable media folder once", async () => {
    await withGoldenCopy(async (library, base) => {
      const issues = await mediaIssues(library, join(base, "absent"));
      expect(issues.map((i) => [i.code, i.file])).toEqual([["unreadable-file", null]]);
      expect(JSON.stringify(issues)).not.toContain(base);
    });
  });

  it("media-outside-folder: a file reached through a link that leaves the folder is not read", async () => {
    await withMedia(async (library, media, files) => {
      // A directory link (a junction on Windows, where file links need extra rights).
      const outside = join(media, "..", "fora");
      await mkdir(outside);
      const moved = files.filter((file) => file.startsWith(`${A}/`));
      for (const file of moved) {
        await writeFile(join(outside, file.split("/")[1] as string), makePng(2, 2, 9));
      }
      await rm(join(media, A), { recursive: true });
      await symlink(outside, join(media, A), "junction");
      const issues = await mediaIssues(library, media, true);
      expect(brief(issues, "media-outside-folder")).toEqual(
        moved.sort().map((file) => ["error", `media:${file}`]),
      );
      expect(brief(issues, "media-mismatch")).toEqual([]);
      expect(brief(issues, "orphan-media").length).toBe(0);
      // An unlisted file in a linked-out folder is not listed either.
      await writeFile(join(outside, "m9.png"), makePng(2, 2, 9));
      expect(brief(await mediaIssues(library, media), "orphan-media")).toEqual([]);
    });
  });
});

describe("resolveMediaPath", () => {
  it("resolves a file inside the folder, and reports a missing one", async () => {
    await withTempDir(async (dir) => {
      await mkdir(join(dir, "ref-20261101-a1b2c3"));
      await writeFile(join(dir, "ref-20261101-a1b2c3", "m1.png"), "x");
      const ok = await resolveMediaPath(dir, "ref-20261101-a1b2c3/m1.png");
      expect(ok.status).toBe("ok");
      expect(await resolveMediaPath(dir, "ref-20261101-a1b2c3/m2.png")).toEqual({
        status: "missing",
      });
      expect(await resolveMediaPath(dir, "ref-20269999-zzzzzz/m1.png")).toEqual({
        status: "missing",
      });
    });
  });

  it.each([
    "../x.png",
    "ref-20261101-a1b2c3/../../x.png",
    "/etc/passwd",
    "a\\b.png",
    "C:/x.png",
    "",
    "a//b.png",
    "./x.png",
  ])("refuses %j before touching the file system", async (path) => {
    await withTempDir(async (dir) => {
      expect(await resolveMediaPath(dir, path)).toEqual({ status: "outside" });
    });
  });

  it("refuses the media folder itself", async () => {
    await withTempDir(async (dir) => {
      await symlink(dir, join(dir, "self"), "junction");
      expect((await resolveMediaPath(dir, "self")).status).toBe("outside");
    });
  });
});
