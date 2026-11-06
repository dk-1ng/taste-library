import { lstat, mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withTempDir } from "@tastelib/testkit";
import { describe, expect, it } from "vitest";
import { withGoldenCopy } from "../../test/support/golden.js";
import { TEST_MARKER_REGISTRY } from "../../test/support/marker-registry.js";
import { serialize } from "../json/canonical.js";
import { MARKER_REGISTRY, serializeMarker } from "../marker.js";
import { findGitWorkTree } from "./folders.js";
import { checkMedia } from "./media.js";
import {
  type AttachResult,
  attachMediaFolder,
  guardMediaWrite,
  isIgnorableEntry,
  MARKER_FILE,
  readMarker,
} from "./media-folder.js";
import { openLibrary } from "./open.js";

const ID = "lib-7d2k9q4m1x";
const OTHER = "lib-0a1b2c3d4e";

/** Every path under `dir` with its size, to prove a refusal leaves a folder unchanged. */
async function listing(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (current: string, prefix: string): Promise<void> => {
    for (const name of (await readdir(current)).sort()) {
      const path = join(current, name);
      const info = await lstat(path);
      out.push(`${prefix}${name}${info.isDirectory() ? "/" : `:${info.size}`}`);
      if (info.isDirectory()) await walk(path, `${prefix}${name}/`);
    }
  };
  await walk(dir, "");
  return out;
}

async function withLibrary<T>(
  fn: (library: { path: string; id: string }, base: string) => Promise<T>,
): Promise<T> {
  return withTempDir(async (base) => {
    const path = join(base, "biblioteca");
    await mkdir(path);
    return fn({ path, id: ID }, base);
  });
}

const refusal = (result: AttachResult): string => {
  if (result.status !== "refused") throw new Error(`expected a refusal, got ${result.status}`);
  return result.code;
};

describe("attachMediaFolder", () => {
  it("creates a missing folder and writes a canonical marker", async () => {
    await withLibrary(async (library, base) => {
      const media = join(base, "mídia");
      const result = await attachMediaFolder(library, media);
      expect(result).toEqual({ status: "attached", folder: media, marker: "written", notices: [] });
      const bytes = await readFile(join(media, MARKER_FILE), "utf8");
      expect(bytes).toBe(serialize("marker", { formatVersion: 1, libraryId: ID }));
      expect(await readdir(media)).toEqual([MARKER_FILE]);
    });
  });

  it("writes the marker in an existing empty folder", async () => {
    await withLibrary(async (library, base) => {
      const media = join(base, "mídia");
      await mkdir(media);
      const result = await attachMediaFolder(library, media);
      expect(result.status === "attached" && result.marker).toBe("written");
    });
  });

  it("attaches the same folder again, keeping the marker and saying so", async () => {
    await withLibrary(async (library, base) => {
      const media = join(base, "mídia");
      await attachMediaFolder(library, media);
      const before = await readFile(join(media, MARKER_FILE));
      const again = await attachMediaFolder(library, media);
      expect(again).toEqual({
        status: "attached",
        folder: media,
        marker: "kept",
        notices: [{ code: "media-already-attached" }],
      });
      expect(await readFile(join(media, MARKER_FILE))).toEqual(before);
    });
  });

  it("accepts a folder that holds only names an operating system or a sync client creates", async () => {
    await withLibrary(async (library, base) => {
      const media = join(base, "mídia");
      await mkdir(media);
      for (const name of [".DS_Store", "THUMBS.DB", "Desktop.INI", ".stfolder", "Icon\r"]) {
        await writeFile(join(media, name), "x");
      }
      await mkdir(join(media, "$recycle.bin"));
      await writeFile(join(media, ".tastelib-media.json.tmp-0a1b2c3d"), "x");
      const result = await attachMediaFolder(library, media);
      expect(result.status).toBe("attached");
      expect(await readdir(media)).toContain(MARKER_FILE);
    });
  });

  it("refuses a folder with anything else in it and leaves it unchanged", async () => {
    for (const make of [
      (media: string) => writeFile(join(media, "foto.png"), "x"),
      (media: string) => writeFile(join(media, ".gitignore"), "x"),
      (media: string) => mkdir(join(media, "vazia")),
      (media: string) => symlink(media, join(media, "link"), "junction"),
      (media: string) => mkdir(join(media, "ref-20261101-a1b2c3")),
      (media: string) => writeFile(join(media, ".tastelib-media.json.tmp-xyz"), "x"),
    ]) {
      await withLibrary(async (library, base) => {
        const media = join(base, "mídia");
        await mkdir(media);
        await make(media);
        const before = await listing(media);
        expect(refusal(await attachMediaFolder(library, media))).toBe("media-folder-not-empty");
        expect(await listing(media)).toEqual(before);
      });
    }
  });

  it("refuses a folder with only this library's reference folders and no marker", async () => {
    await withLibrary(async (library, base) => {
      const media = join(base, "mídia");
      await mkdir(join(media, "ref-20261101-a1b2c3"), { recursive: true });
      await writeFile(join(media, "ref-20261101-a1b2c3", "m1.png"), "x");
      const before = await listing(media);
      expect(refusal(await attachMediaFolder(library, media))).toBe("media-folder-not-empty");
      expect(await listing(media)).toEqual(before);
    });
  });

  it("refuses the library folder itself and a folder inside it, writing nothing", async () => {
    await withLibrary(async (library) => {
      const before = await listing(library.path);
      expect(refusal(await attachMediaFolder(library, library.path))).toBe("media-inside-library");
      expect(refusal(await attachMediaFolder(library, join(library.path, "midia")))).toBe(
        "media-inside-library",
      );
      await mkdir(join(library.path, "midia"));
      expect(refusal(await attachMediaFolder(library, join(library.path, "midia")))).toBe(
        "media-inside-library",
      );
      expect(await listing(library.path)).toEqual([...before, "midia/"].sort());
    });
  });

  it("refuses a folder reached through a symbolic link or junction into the library", async () => {
    await withLibrary(async (library, base) => {
      await mkdir(join(library.path, "midia"));
      const link = join(base, "atalho");
      await symlink(library.path, link, "junction");
      expect(refusal(await attachMediaFolder(library, join(link, "midia")))).toBe(
        "media-inside-library",
      );
      expect(refusal(await attachMediaFolder(library, join(link, "nova")))).toBe(
        "media-inside-library",
      );
      expect(refusal(await attachMediaFolder(library, link))).toBe("media-inside-library");
      expect(await readdir(library.path)).toEqual(["midia"]);
    });
  });

  it("refuses a folder that contains the library", async () => {
    await withLibrary(async (library, base) => {
      const before = await listing(base);
      expect(refusal(await attachMediaFolder(library, base))).toBe("library-inside-media");
      const link = join(base, "..", "outro");
      await symlink(base, link, "junction");
      expect(refusal(await attachMediaFolder(library, link))).toBe("library-inside-media");
      await rm(link, { recursive: true, force: true });
      expect(await listing(base)).toEqual(before);
    });
  });

  it("refuses a folder inside a Git working tree, existing or not", async () => {
    await withLibrary(async (library, base) => {
      const repo = join(base, "repositório");
      await mkdir(join(repo, ".git"), { recursive: true });
      expect(refusal(await attachMediaFolder(library, join(repo, "midia")))).toBe(
        "media-inside-git",
      );
      await mkdir(join(repo, "midia"));
      expect(refusal(await attachMediaFolder(library, join(repo, "midia")))).toBe(
        "media-inside-git",
      );
      expect(await listing(repo)).toEqual([".git/", "midia/"]);
    });
  });

  it("reports the library check before the Git check when the library is a repository", async () => {
    await withLibrary(async (library) => {
      await mkdir(join(library.path, ".git"));
      expect(refusal(await attachMediaFolder(library, join(library.path, "midia")))).toBe(
        "media-inside-library",
      );
    });
  });

  it("refuses a path that is a file", async () => {
    await withLibrary(async (library, base) => {
      const file = join(base, "arquivo");
      await writeFile(file, "x");
      expect(refusal(await attachMediaFolder(library, file))).toBe("not-a-folder");
      expect(refusal(await attachMediaFolder(library, join(file, "sub")))).toBe("not-a-folder");
    });
  });

  it("refuses a missing folder whose parent is missing too, and creates one level only", async () => {
    await withLibrary(async (library, base) => {
      const media = join(base, "a", "b");
      expect(refusal(await attachMediaFolder(library, media))).toBe("parent-folder-missing");
      expect(await readdir(base)).toEqual(["biblioteca"]);
      const ok = await attachMediaFolder(library, join(base, "a"));
      expect(ok.status).toBe("attached");
    });
  });

  it("refuses another library's folder and leaves it unchanged", async () => {
    await withLibrary(async (library, base) => {
      const media = join(base, "mídia");
      await mkdir(join(base, "outra"));
      await attachMediaFolder({ path: join(base, "outra"), id: OTHER }, media);
      const before = await readFile(join(media, MARKER_FILE));
      const result = await attachMediaFolder(library, media);
      expect(refusal(result)).toBe("media-folder-mismatch");
      expect(result.status === "refused" && result.message).toContain(OTHER);
      expect(await readFile(join(media, MARKER_FILE))).toEqual(before);
    });
  });

  it("refuses a damaged marker with its issues", async () => {
    for (const content of ["{", '{"formatVersion":1}', "[]", ""]) {
      await withLibrary(async (library, base) => {
        const media = join(base, "mídia");
        await mkdir(media);
        await writeFile(join(media, MARKER_FILE), content);
        const result = await attachMediaFolder(library, media);
        expect(refusal(result)).toBe("media-marker-unreadable");
        expect(result.status === "refused" && result.issues[0]?.file).toBe(`media:${MARKER_FILE}`);
        expect(await readFile(join(media, MARKER_FILE), "utf8")).toBe(content);
      });
    }
  });

  it("refuses a marker whose path is a folder", async () => {
    await withLibrary(async (library, base) => {
      const media = join(base, "mídia");
      await mkdir(join(media, MARKER_FILE), { recursive: true });
      expect(refusal(await attachMediaFolder(library, media))).toBe("media-marker-unreadable");
    });
  });

  it("refuses a newer marker and leaves it unchanged", async () => {
    await withLibrary(async (library, base) => {
      const media = join(base, "mídia");
      await mkdir(media);
      const text = `{"formatVersion":9,"libraryId":"${ID}","extra":true}`;
      await writeFile(join(media, MARKER_FILE), text);
      const result = await attachMediaFolder(library, media);
      expect(refusal(result)).toBe("newer-format");
      expect(result.status === "refused" && result.message).toContain("marker format 9");
      expect(await readFile(join(media, MARKER_FILE), "utf8")).toBe(text);
    });
  });

  it("migrates an older marker on disk when it is attached again", async () => {
    await withLibrary(async (library, base) => {
      const media = join(base, "mídia");
      await attachMediaFolder(library, media);
      const result = await attachMediaFolder(library, media, {
        markerRegistry: TEST_MARKER_REGISTRY,
      });
      expect(result).toEqual({
        status: "attached",
        folder: media,
        marker: "migrated",
        notices: [{ code: "media-already-attached" }],
      });
      expect(await readFile(join(media, MARKER_FILE), "utf8")).toBe(
        serializeMarker(TEST_MARKER_REGISTRY, {
          formatVersion: 2,
          libraryId: ID,
          createdBy: "migration",
        }),
      );
      expect(await readdir(media)).toEqual([MARKER_FILE]);
    });
  });

  it("writes a new marker at the registry's current version, through the same steps", async () => {
    await withLibrary(async (library, base) => {
      const media = join(base, "mídia");
      await attachMediaFolder(library, media, { markerRegistry: TEST_MARKER_REGISTRY });
      expect(JSON.parse(await readFile(join(media, MARKER_FILE), "utf8"))).toEqual({
        formatVersion: 2,
        libraryId: ID,
        createdBy: "migration",
      });
    });
  });

  it("ends failed, removing the folder it created, when the marker cannot be written", async () => {
    await withLibrary(async (library, base) => {
      const media = join(base, "mídia");
      const result = await attachMediaFolder(library, media, {
        write: {
          fs: {
            ...(await import("node:fs/promises")),
            open: async () => {
              throw Object.assign(new Error("denied"), { code: "EACCES" });
            },
          },
        },
      });
      expect(result.status).toBe("failed");
      expect(await readdir(base)).toEqual(["biblioteca"]);
    });
  });
});

describe("the marker file", () => {
  it("is exactly the canonical form of the marker schema", () => {
    expect(serializeMarker(MARKER_REGISTRY, { libraryId: ID, formatVersion: 1 })).toBe(
      serialize("marker", { formatVersion: 1, libraryId: ID }),
    );
  });
});

describe("isIgnorableEntry", () => {
  it("compares after NFC and without case", () => {
    expect(isIgnorableEntry("System Volume Information")).toBe(true);
    expect(isIgnorableEntry("system volume information")).toBe(true);
    expect(isIgnorableEntry(".dropbox.attr")).toBe(true);
    expect(isIgnorableEntry(".dropbox.other")).toBe(false);
    expect(isIgnorableEntry(".git")).toBe(false);
  });
});

describe("guardMediaWrite and readMarker", () => {
  async function attached(base: string): Promise<string> {
    const media = join(base, "mídia");
    await attachMediaFolder({ path: join(base, "biblioteca"), id: ID }, media);
    return media;
  }

  it("lets a write through when the marker is this library's and current", async () => {
    await withLibrary(async (_library, base) => {
      const media = await attached(base);
      expect(await guardMediaWrite(media, ID)).toEqual({ status: "ok", marker: "kept" });
    });
  });

  it("migrates an older marker on disk, but readMarker only in memory", async () => {
    await withLibrary(async (_library, base) => {
      const media = await attached(base);
      const before = await readFile(join(media, MARKER_FILE));
      const memory = await readMarker(media, ID, TEST_MARKER_REGISTRY);
      expect(memory).toMatchObject({
        status: "ok",
        version: 1,
        value: { formatVersion: 2, createdBy: "migration" },
      });
      expect(await readFile(join(media, MARKER_FILE))).toEqual(before);
      expect(await guardMediaWrite(media, ID, { markerRegistry: TEST_MARKER_REGISTRY })).toEqual({
        status: "ok",
        marker: "migrated",
      });
      expect(JSON.parse(await readFile(join(media, MARKER_FILE), "utf8"))).toMatchObject({
        formatVersion: 2,
      });
    });
  });

  it("refuses another library's marker, a missing marker, a damaged one and a newer one", async () => {
    await withLibrary(async (_library, base) => {
      const media = await attached(base);
      const refused = async (id: string) => {
        const result = await guardMediaWrite(media, id);
        return result.status === "refused" ? result.code : result.status;
      };
      expect(await refused(OTHER)).toBe("media-folder-mismatch");
      await writeFile(join(media, MARKER_FILE), "{");
      expect(await refused(ID)).toBe("media-marker-unreadable");
      await writeFile(join(media, MARKER_FILE), `{"formatVersion":3,"libraryId":"${ID}"}`);
      expect(await refused(ID)).toBe("newer-format");
      expect(await readFile(join(media, MARKER_FILE), "utf8")).toContain('"formatVersion":3');
      await rm(join(media, MARKER_FILE));
      expect(await refused(ID)).toBe("media-marker-missing");
      expect(await readdir(media)).toEqual([]);
    });
  });
});

describe("the attached marker", () => {
  it("passes validation with no marker issue", async () => {
    await withGoldenCopy(async (library, base) => {
      const opened = await openLibrary(library);
      if (!opened.ok) throw new Error(opened.message);
      const snapshot = await opened.library.snapshot();
      if (!snapshot.ok) throw new Error(snapshot.message);
      const id = (
        JSON.parse(await readFile(join(library, "library.json"), "utf8")) as { id: string }
      ).id;
      const media = join(base, "mídia");
      expect((await attachMediaFolder({ path: library, id }, media)).status).toBe("attached");
      const issues = await checkMedia(snapshot.snapshot, media, {});
      expect(issues.filter((issue) => issue.file === `media:${MARKER_FILE}`)).toEqual([]);
    });
  });
});

describe("findGitWorkTree", () => {
  it("finds the nearest working tree, for a folder that does not exist yet", async () => {
    await withTempDir(async (base) => {
      await mkdir(join(base, "repo", ".git"), { recursive: true });
      expect(await findGitWorkTree(join(base, "repo", "a", "b"))).toMatchObject({
        status: "found",
      });
      expect(await findGitWorkTree(base)).toEqual({ status: "none" });
    });
  });
});
