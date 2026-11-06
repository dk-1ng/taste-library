import { expect } from "vitest";
import type { LibraryIndex } from "../../src/library-index/build.js";
import { type Library, type OpenOptions, openLibrary } from "../../src/node/open.js";
import type { SnapshotResult } from "../../src/node/open.js";
import type { Snapshot } from "../../src/validation/library.js";

/**
 * "Rebuild equals updates" (docs/design.md section 4, "Index", "How it is built"): the snapshot of
 * an open handle, refreshed, must equal the snapshot of a fresh open of the same folder.
 * Test-only: it lives outside `src/`.
 */

const sorted = (items: Iterable<string>): string[] =>
  [...items].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

function comparableIndex(index: LibraryIndex) {
  const { targets } = index;
  return {
    versions: index.versions,
    references: [...index.references],
    families: [...index.families],
    familiesOf: [...index.familiesOf],
    targets: {
      references: sorted(targets.references.keys()).map((id) => [
        id,
        [...(targets.references.get(id) ?? [])],
      ]),
      families: sorted(targets.families),
      projects: sorted(targets.projects),
      directions: sorted(targets.directions.keys()).map((slug) => [
        slug,
        [...(targets.directions.get(slug) ?? [])],
      ]),
      guardrails: sorted(targets.guardrails),
    },
    backlinks: [...index.backlinks],
    backlinksToReference: [...index.backlinksToReference],
  };
}

function comparableSnapshot(snapshot: Snapshot) {
  return {
    formatVersion: snapshot.formatVersion,
    files: [...snapshot.files].map(([path, file]) => [
      path,
      {
        ...file,
        bytes: file.bytes === null ? null : Buffer.from(file.bytes).toString("base64"),
      },
    ]),
    issues: snapshot.issues,
    unlistedFolders: snapshot.unlistedFolders,
    index: comparableIndex(snapshot.index),
  };
}

/** A snapshot result as plain data: Maps as arrays in iteration order, bytes as base64, sets sorted. */
export function comparable(result: SnapshotResult) {
  return result.ok ? { ok: true, snapshot: comparableSnapshot(result.snapshot) } : result;
}

/** The handle's refreshed snapshot equals a fresh open's, order included. */
export async function expectMatchesRebuild(
  library: Library,
  root: string,
  options: OpenOptions = {},
): Promise<void> {
  const updated = comparable(await library.snapshot());
  const opened = await openLibrary(root, options);
  const rebuilt = opened.ok ? comparable(await opened.library.snapshot()) : opened;
  expect(updated).toEqual(rebuilt);
}
