/**
 * The production table of migration steps (format-spec §15.4; docs/design.md section 3, "Core
 * modules and API"). Pure. Each step lives in its own module, `v<N>-to-v<N+1>.ts` in this
 * folder, and is listed here under N; the format registry (`format.ts`) takes this table. At
 * version 1 there is no step. The test-only step v1 to v2 lives in `test/migrations/`, outside
 * `src/`, so it can never reach `dist/`; the chain test checks that this table and the registry
 * agree with the versions there are.
 */

/**
 * A whole library as a step sees it: each file's path relative to the library (with `/`) to its
 * parsed JSON. A step returns its files sorted by path.
 */
export type LibraryValues = ReadonlyMap<string, unknown>;

/**
 * One step from version N to version N + 1: pure, deterministic and synchronous, from the whole
 * library to the whole library. It may change, add, move or remove files; it touches only files
 * at version N, passes the others through unchanged, and never changes its input.
 */
export type MigrationStep = (library: LibraryValues) => LibraryValues;

/** `FORMAT_STEPS[n]` turns version n into version n + 1. */
export const FORMAT_STEPS: Readonly<Record<number, MigrationStep>> = {};
