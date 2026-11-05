import { cp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fnv1a32, makeStablePng, withTempDir } from "@tastelib/testkit";

/**
 * Test support for the golden libraries (docs/design.md section 15, "Format and migration tests").
 * Test-only: it lives outside `src/`, so it can never reach `dist/`.
 */

/** The golden v1 library folder: JSON only, hand-written, frozen. */
export const GOLDEN_V1 = join(import.meta.dirname, "..", "golden", "v1");

interface ListedFile {
  file: string;
  width: number;
  height: number;
  type: string;
}

/** Every media file and frame the golden references list, read from the frozen JSON. */
async function listedMedia(library: string): Promise<ListedFile[]> {
  const out: ListedFile[] = [];
  for (const name of (await readdir(join(library, "references"))).sort()) {
    const reference = JSON.parse(await readFile(join(library, "references", name), "utf8")) as {
      media: (ListedFile & { frames: ListedFile[] })[];
    };
    for (const media of reference.media) {
      out.push(media);
      out.push(...media.frames);
    }
  }
  return out;
}

/**
 * Writes the media folder of a golden library: the marker with the library's id, and for each
 * media item and frame a `makeStablePng` image of the listed size, seeded with the 32-bit FNV-1a
 * hash of its media path. The bytes never change, because the frozen JSON records their size and
 * checksum.
 */
export async function writeGoldenMedia(library: string, mediaFolder: string): Promise<string[]> {
  const { id } = JSON.parse(await readFile(join(library, "library.json"), "utf8")) as {
    id: string;
  };
  await mkdir(mediaFolder, { recursive: true });
  await writeFile(
    join(mediaFolder, "tastelib-media.json"),
    `${JSON.stringify({ formatVersion: 1, libraryId: id }, null, 2)}\n`,
  );
  const written: string[] = [];
  for (const media of await listedMedia(library)) {
    if (media.type !== "image/png") {
      throw new Error(`The golden library lists ${media.type}; only image/png has a generator.`);
    }
    const target = join(mediaFolder, ...media.file.split("/"));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, makeStablePng(media.width, media.height, fnv1a32(media.file)));
    written.push(media.file);
  }
  return written;
}

/**
 * Runs `fn` with a copy of the golden v1 library in a folder under a non-ASCII temporary path
 * (`.../Usuário-日本/biblioteca`). The copy is the test's to change.
 */
export async function withGoldenCopy<T>(
  fn: (library: string, base: string) => Promise<T>,
): Promise<T> {
  return withTempDir(async (base) => {
    const library = join(base, "biblioteca");
    await cp(GOLDEN_V1, library, { recursive: true });
    return fn(library, base);
  });
}

/** Reads a JSON file of a library, lets `change` edit it, and writes it back as two-space JSON plus LF. */
export async function editJson(
  library: string,
  relative: string,
  // biome-ignore lint/suspicious/noExplicitAny: tests edit arbitrary JSON, including to break it
  change: (value: any) => void,
): Promise<void> {
  const path = join(library, ...relative.split("/"));
  const value = JSON.parse(await readFile(path, "utf8"));
  change(value);
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}
