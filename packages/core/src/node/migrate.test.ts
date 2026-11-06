import { createHash } from "node:crypto";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { withGoldenCopy } from "../../test/support/golden.js";
import { open, tree } from "../../test/support/library.js";
import { TEST_REGISTRY } from "../../test/support/registry.js";
import { FORMAT_REGISTRY } from "../format.js";
import { planMigration } from "../migrations/plan.js";
import { dryRunMigration } from "./migrate.js";

/**
 * The migration dry run (docs/design.md section 4, "`tastelib migrate`", `--dry-run`): it plans in
 * memory and writes nothing, not even `.tastelib/`.
 */

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

describe("dryRunMigration", () => {
  it("returns the plan of an older library and leaves the folder byte for byte as it was", async () => {
    await withGoldenCopy(async (library) => {
      const before = await tree(library);
      const handle = await open(library, TEST_REGISTRY);
      const result = await dryRunMigration(library, handle, { registry: TEST_REGISTRY });
      const snapshot = await handle.snapshot();
      if (!snapshot.ok) throw new Error(snapshot.message);
      const plan = planMigration(TEST_REGISTRY, snapshot.snapshot, sha256);
      if (plan.status !== "ready" || result.status !== "ready") throw new Error("not ready");
      // The same plan; the migrated snapshots hold functions, so they are compared by their files.
      const { migrated, ...lists } = result;
      const { migrated: expected, ...expectedLists } = plan;
      expect(lists).toEqual(expectedLists);
      expect([...migrated.files.keys()]).toEqual([...expected.files.keys()]);
      expect(result).toMatchObject({ status: "ready", from: 1, to: 2, removed: ["glossary.json"] });
      expect(await tree(library)).toEqual(before);
      expect(Object.keys(before).some((path) => path.startsWith(".tastelib"))).toBe(false);
    });
  });

  it("says a current library is current, and writes nothing", async () => {
    await withGoldenCopy(async (library) => {
      const before = await tree(library);
      const result = await dryRunMigration(library, await open(library));
      expect(result).toEqual({ status: "current" });
      expect(await tree(library)).toEqual(before);
    });
  });

  it("returns the issues that block the migration", async () => {
    await withGoldenCopy(async (library) => {
      await writeFile(join(library, "guardrails.json"), "{ not json");
      const before = await tree(library);
      const result = await dryRunMigration(library, await open(library, TEST_REGISTRY), {
        registry: TEST_REGISTRY,
      });
      expect(result).toMatchObject({
        status: "blocked",
        step: 1,
        issues: [{ code: "invalid-json", file: "guardrails.json" }],
      });
      expect(await tree(library)).toEqual(before);
    });
  });

  it("gives no plan when a migration backup exists, and leaves it as it is", async () => {
    await withGoldenCopy(async (library) => {
      await mkdir(join(library, ".tastelib", "migration-backup"), { recursive: true });
      const before = await tree(library);
      const result = await dryRunMigration(library, await open(library, TEST_REGISTRY), {
        registry: TEST_REGISTRY,
      });
      expect(result).toEqual({ status: "backup" });
      expect(await tree(library)).toEqual(before);
    });
  });

  it("finds the backup with lstat, so a link there that leads nowhere counts", async () => {
    await withGoldenCopy(async (library) => {
      await mkdir(join(library, ".tastelib"));
      try {
        await symlink(join(library, "nowhere"), join(library, ".tastelib", "migration-backup"));
      } catch {
        return; // creating links needs extra rights on some Windows setups
      }
      const result = await dryRunMigration(library, await open(library, TEST_REGISTRY), {
        registry: TEST_REGISTRY,
      });
      expect(result).toEqual({ status: "backup" });
    });
  });

  it("plans when .tastelib is a file, which holds no backup", async () => {
    await withGoldenCopy(async (library) => {
      await writeFile(join(library, ".tastelib"), "");
      const result = await dryRunMigration(library, await open(library, TEST_REGISTRY), {
        registry: TEST_REGISTRY,
      });
      expect(result).toMatchObject({ status: "ready" });
    });
  });

  it("turns an error looking for the backup into an io-error result, never a throw", async () => {
    await withGoldenCopy(async (library) => {
      const lstat = async (): Promise<never> => {
        throw Object.assign(new Error("injected"), { code: "EACCES" });
      };
      const result = await dryRunMigration(library, await open(library), {
        registry: FORMAT_REGISTRY,
        lstat,
      });
      expect(result).toMatchObject({
        status: "failed",
        failure: {
          code: "io-error",
          operation: "lstat",
          file: ".tastelib/migration-backup",
          errno: "EACCES",
        },
      });
      expect(JSON.stringify(result)).not.toContain(library);
    });
  });

  it("returns the open failure when the folder is no longer a library", async () => {
    await withGoldenCopy(async (library) => {
      const handle = await open(library);
      await rm(join(library, "library.json"));
      expect(await dryRunMigration(library, handle)).toEqual({
        status: "failed",
        failure: { code: "not-a-library", message: expect.any(String) },
      });
    });
  });
});
