import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { currentLayout, FORMAT_REGISTRY } from "../../src/format.js";
import { kindOfPath } from "../../src/node/write.js";
import { makeIssue } from "../../src/validation/issue.js";
import { buildSnapshot, type LibraryEntry, type Snapshot } from "../../src/validation/library.js";
import { GOLDEN_V1 } from "./golden.js";

/**
 * Snapshots of the golden v1 library built in memory, for tests of pure code that takes a
 * snapshot (the deletion planners). Test-only: it lives outside `src/`.
 */

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** Every file of the golden v1 library: relative path to parsed value. */
function goldenFiles(): Map<string, unknown> {
  const files = new Map<string, unknown>();
  const walk = (relative: string): void => {
    for (const entry of readdirSync(join(GOLDEN_V1, ...relative.split("/").filter(Boolean)), {
      withFileTypes: true,
    })) {
      const path = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else files.set(path, JSON.parse(readFileSync(join(GOLDEN_V1, ...path.split("/")), "utf8")));
    }
  };
  walk("");
  return new Map([...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

export interface GoldenSnapshotOptions {
  /** Folders to treat as existing but unreadable: their files are left out, as the listing does. */
  unlisted?: string[];
}

/**
 * The golden v1 library as a snapshot. `edit` may change the parsed values in place, delete files,
 * or set a value to a string, which becomes the file's exact text (to make a file with errors).
 */
export function goldenSnapshot(
  edit?: (files: Map<string, unknown>) => void,
  options: GoldenSnapshotOptions = {},
): Snapshot {
  const files = goldenFiles();
  edit?.(files);
  const unlisted = options.unlisted ?? [];
  const layout = currentLayout(FORMAT_REGISTRY);
  const encoder = new TextEncoder();
  const entries: LibraryEntry[] = [];
  for (const [path, value] of files) {
    if (unlisted.some((folder) => path.startsWith(`${folder}/`))) continue;
    const kind = kindOfPath(layout, path);
    if (kind === null) throw new Error(`${path} is not a file of the format.`);
    const text = typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`;
    entries.push({ path, kind, read: { status: "ok", bytes: encoder.encode(text) } });
  }
  const folderIssues = unlisted.map((folder) =>
    makeIssue("unreadable-file", folder, null, "The folder cannot be read (EACCES)."),
  );
  return buildSnapshot(FORMAT_REGISTRY, entries, folderIssues, sha256, unlisted);
}
