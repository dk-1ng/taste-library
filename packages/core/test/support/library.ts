import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { FORMAT_REGISTRY, type FormatRegistry } from "../../src/format.js";
import { type Library, type OpenOptions, openLibrary } from "../../src/node/open.js";
import type { Issue } from "../../src/validation/issue.js";

/** Test helpers for libraries on disk. Test-only: it lives outside `src/`. */

// biome-ignore lint/suspicious/noExplicitAny: tests read and edit arbitrary JSON
export type Json = any;

export async function open(
  library: string,
  registry: FormatRegistry = FORMAT_REGISTRY,
  options: OpenOptions = {},
): Promise<Library> {
  const opened = await openLibrary(library, { ...options, registry });
  if (!opened.ok) throw new Error(opened.message);
  return opened.library;
}

/** Every file under `dir` with its bytes, and every folder, to prove what a write changed. */
export async function tree(dir: string, prefix = ""): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const entry of await readdir(join(dir, prefix), { withFileTypes: true })) {
    const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      out[`${path}/`] = "";
      Object.assign(out, await tree(dir, path));
    } else {
      out[path] = await readFile(join(dir, path), "utf8");
    }
  }
  return out;
}

export async function readJson(library: string, path: string): Promise<Json> {
  return JSON.parse(await readFile(join(library, ...path.split("/")), "utf8"));
}

/** The issues of the library as it is on disk now, without the `info` ones. */
export async function issuesOnDisk(library: string): Promise<Issue[]> {
  const opened = await openLibrary(library);
  if (!opened.ok) throw new Error(opened.message);
  const snapshot = await opened.library.snapshot();
  if (!snapshot.ok) throw new Error(snapshot.message);
  return snapshot.snapshot.issues.filter((issue) => issue.severity !== "info");
}

/** The names of temporary files anywhere in `tree`. */
export function temporaryFiles(files: Record<string, string>): string[] {
  return Object.keys(files).filter((path) => path.includes(".tmp-"));
}
