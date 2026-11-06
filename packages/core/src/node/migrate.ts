import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { FORMAT_REGISTRY, type FormatRegistry } from "../format.js";
import { type MigrationPlan, planMigration } from "../migrations/plan.js";
import type { Library } from "./open.js";
import { BACKUP, backupPresent, type WriteFailure } from "./write.js";

/**
 * Migrating a library on disk (format-spec §15.3; docs/design.md section 4, "`tastelib migrate`").
 * For now, the dry run: it plans the migration in memory with the same planner as the migration
 * runner and the snapshot's migrated view, and only reads: no gate, no recovery, nothing written,
 * not even `.tastelib/`.
 */

export interface DryRunOptions {
  /** The registry the library was opened with; the production one by default. */
  registry?: FormatRegistry;
  /** SHA-256 of bytes as lowercase hex, for the checks across files; `node:crypto` by default. */
  sha256?: (bytes: Uint8Array) => string;
  /** Replaces the `lstat` that looks for the migration backup (tests inject failures). */
  lstat?: (path: string) => Promise<unknown>;
}

/**
 * What a dry run gives: the plan (`current`, `blocked` with the issues that block it, or `ready`
 * with the files that would change, be added and be removed); `backup` when a migration backup
 * exists, since the files may then be half-migrated and no plan is given; or `failed`, when the
 * folder is no longer a readable library or the backup cannot be looked for (`io-error`).
 */
export type DryRunResult =
  | MigrationPlan
  | { status: "backup" }
  | { status: "failed"; failure: WriteFailure };

const sha256Hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

function errnoOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && !code.startsWith("ERR_") ? code : undefined;
}

/**
 * Plans the migration of the library in `root`, opened as `library`, without writing anything.
 * Expected failures are results, never thrown.
 */
export async function dryRunMigration(
  root: string,
  library: Pick<Library, "snapshot">,
  options: DryRunOptions = {},
): Promise<DryRunResult> {
  const registry = options.registry ?? FORMAT_REGISTRY;
  const result = await library.snapshot();
  if (!result.ok) {
    return { status: "failed", failure: { code: result.code, message: result.message } };
  }
  try {
    if (await backupPresent(root, options.lstat ?? lstat)) return { status: "backup" };
  } catch (error) {
    const errno = errnoOf(error);
    if (errno === undefined) throw error;
    return {
      status: "failed",
      failure: {
        code: "io-error",
        operation: "lstat",
        file: BACKUP,
        errno,
        message: `The migration backup folder cannot be looked for (${errno}).`,
      },
    };
  }
  return planMigration(registry, result.snapshot, options.sha256 ?? sha256Hex);
}
