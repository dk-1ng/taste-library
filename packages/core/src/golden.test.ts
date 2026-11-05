import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { withTempDir } from "@tastelib/testkit";
import { describe, expect, it } from "vitest";
import { FORMAT_REGISTRY, reportOf } from "./browser.js";
import { openLibrary } from "./index.js";
import { GOLDEN_V1, writeGoldenMedia } from "../test/support/golden.js";

/** Every file of the golden library as `relative/path`, sorted. */
async function goldenFiles(dir = GOLDEN_V1, prefix = ""): Promise<string[]> {
  const out: string[] = [];
  for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
    a.name < b.name ? -1 : 1,
  )) {
    if (entry.isDirectory())
      out.push(...(await goldenFiles(join(dir, entry.name), `${prefix}${entry.name}/`)));
    else out.push(`${prefix}${entry.name}`);
  }
  return out;
}

const FROZEN: Readonly<Record<string, string>> = {
  "families/dense-dashboards.json":
    "9e2b919695c8fd1007182711b188c3bb15274c0d718b707711e70d7da39e9e74",
  "families/quiet-editorial.json":
    "321e1833d09524489a715e0e8e35c13d79b9e091101a55114a74632fb21cadc1",
  "glossary.json": "9e18c3ff5c98a7eecf207e26ed8ac872cf049e9e2d5b49a9c82d4458cb5520d5",
  "guardrails.json": "39aaa8ca388643a3964885d342bbe5057bad0dbcff5c0afc9ac362474698d603",
  "library.json": "58d0bf0634f4b44514a657068ca936efbd36b80d3e42bef10a3f0583003cc186",
  "projects/internal-dashboard/project.json":
    "ad84ce6e8687d9eb455c1df93de8d5eab8c10b669ef2d4339433de56db6c2ea3",
  "projects/landing-redesign/directions.json":
    "ed66e8f8d39063dd7315991d742c9f3c7877f2e2321d1f52f4eabb51bf3cef4c",
  "projects/landing-redesign/project.json":
    "4517f00087288f4ae054b5314dfd8074448b57fd27a01ecc17b26ad9865b3f06",
  "references/ref-20261101-a1b2c3.json":
    "86915407d9ddb23e8ad8112954491c263dee03ad9d673af83e0356336c4667b5",
  "references/ref-20261102-d4e5f6.json":
    "8114e27c9824c29bd331b22decd4a6824b673feb93b719092db7f8e502aef7b7",
  "references/ref-20261103-g7h8j9.json":
    "8a0add43d4a6a022cde6c557e009d7108c8454ea145cbb62e04b2eeba5d75124",
  "references/ref-20261104-m2n3p4.json":
    "630fc096c543f738121a862ce63eee0a20c9abfc352f895b18ef71d03ae566dc",
  "taste-profile.json": "b0f8c20ceb63512cbd1d8c632d31a2e3186b0aba484026e2f3b26d322a593d50",
};

// biome-ignore lint/suspicious/noExplicitAny: the test reads arbitrary frozen JSON
async function readJson(relative: string): Promise<any> {
  return JSON.parse(await readFile(join(GOLDEN_V1, ...relative.split("/")), "utf8"));
}

describe("the golden v1 library", () => {
  it("is frozen: every file it had when version 1 was released is unchanged", async () => {
    // A fixture is frozen once its version is released (docs/design.md section 15): it is never
    // edited, only added to. A new file may be added; add its digest here too.
    const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
    for (const [file, digest] of Object.entries(FROZEN)) {
      expect(sha256(await readFile(join(GOLDEN_V1, ...file.split("/")))), file).toBe(digest);
    }
    expect((await goldenFiles()).sort()).toEqual(Object.keys(FROZEN).sort());
  });

  it("is JSON only, with LF line endings", async () => {
    for (const file of await goldenFiles()) {
      expect(file.endsWith(".json"), file).toBe(true);
      expect(
        (await readFile(join(GOLDEN_V1, ...file.split("/")), "utf8")).includes("\r"),
        file,
      ).toBe(false);
    }
  });

  it("covers every file type", async () => {
    const files = await goldenFiles();
    expect(files).toContain("library.json");
    expect(files.some((f) => f.startsWith("references/"))).toBe(true);
    expect(files.some((f) => f.startsWith("families/"))).toBe(true);
    expect(files).toContain("glossary.json");
    expect(files).toContain("guardrails.json");
    expect(files).toContain("taste-profile.json");
    expect(files.some((f) => /^projects\/[^/]+\/project\.json$/.test(f))).toBe(true);
    expect(files.some((f) => /^projects\/[^/]+\/directions\.json$/.test(f))).toBe(true);
  });

  it("holds both forms of Authored, every review status and a reference chosen with the file picker", async () => {
    const texts = await Promise.all(
      (await goldenFiles()).map((f) => readFile(join(GOLDEN_V1, ...f.split("/")), "utf8")),
    );
    const all = texts.join("\n");
    expect(all).toContain('"origin": "user"');
    expect(all).toContain('"origin": "agent"');
    for (const status of ["to-review", "accepted", "corrected", "rejected"]) {
      expect(all, status).toContain(`"status": "${status}"`);
    }
    for (const via of ["paste", "drop", "file-picker", "url-capture"]) {
      expect(all, via).toContain(`"via": "${via}"`);
    }
    expect(all).not.toContain('"video');
  });

  it("validates with no issue at all but media-not-checked when no media folder is given", async () => {
    const opened = await openLibrary(GOLDEN_V1);
    if (!opened.ok) throw new Error(opened.message);
    const result = await opened.library.snapshot();
    if (!result.ok) throw new Error(result.message);
    expect(result.snapshot.issues).toEqual([]);
    expect(result.snapshot.formatVersion).toBe(1);
    const report = reportOf(FORMAT_REGISTRY, result.snapshot);
    expect(report.counts).toEqual({ error: 0, warning: 0, info: 1 });
    expect(report.issues).toMatchObject([
      { severity: "info", code: "media-not-checked", file: null, pointer: null },
    ]);
  });

  it("lists media that its generator reproduces byte for byte", async () => {
    await withTempDir(async (dir) => {
      const written = await writeGoldenMedia(GOLDEN_V1, join(dir, "media"));
      expect(written.length).toBeGreaterThanOrEqual(5);
      const listed: Record<string, { bytes: number; sha256: string }> = {};
      for (const name of await readdir(join(GOLDEN_V1, "references"))) {
        const reference = await readJson(`references/${name}`);
        for (const media of reference.media) {
          expect(media.type).toBe("image/png");
          expect(media.width).toBeLessThanOrEqual(64);
          expect(media.height).toBeLessThanOrEqual(64);
          listed[media.file] = { bytes: media.bytes, sha256: media.sha256 };
        }
      }
      expect(Object.keys(listed).sort()).toEqual([...written].sort());
      for (const [file, expected] of Object.entries(listed)) {
        const bytes = await readFile(join(dir, "media", ...file.split("/")));
        expect(bytes.length, file).toBe(expected.bytes);
        expect(createHash("sha256").update(bytes).digest("hex"), file).toBe(expected.sha256);
      }
      const marker = JSON.parse(await readFile(join(dir, "media", "tastelib-media.json"), "utf8"));
      expect(marker).toEqual({ formatVersion: 1, libraryId: (await readJson("library.json")).id });
    });
  });
});
