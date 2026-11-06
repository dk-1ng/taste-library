import { lstat, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { recordPoints, SimulatedCrash } from "../../test/support/crash.js";
import { type FaultyFs, faultyFs } from "../../test/support/faulty-fs.js";
import { readTree, withGoldenCopy } from "../../test/support/golden.js";
import { open, readJson, tree } from "../../test/support/library.js";
import { TEST_REGISTRY } from "../../test/support/registry.js";
import type { Library, OpenOptions } from "./open.js";
import type { LibraryWriteOptions, MigrateResult, WriteResult } from "./write.js";

/**
 * A migration that fails after its claim (docs/design.md section 4, "Migration runner failures";
 * section 15, "Core test approach", "Runner failures"): it cleans up its own backup before it
 * returns, undoing only what this run did, and when that cleanup fails too, the owning handle
 * finishes it before its next write. Run with the test-only version 2 and the golden v1 library,
 * whose migration changes every file but `glossary.json`, adds one `glossary/<term-id>.json` per
 * term and removes `glossary.json`.
 */

const NOW = new Date("2026-11-05T10:00:00.000Z");
const clock = () => NOW;
const HOST = "test-host";
const PID = 4242;
const BACKUP = ".tastelib/migration-backup";
const OWNER = `${BACKUP}/owner.json`;
const MANIFEST = `${BACKUP}/manifest.json`;
const decoder = new TextDecoder();

/** The step-5 writes of the golden library, in the order the runner writes them. */
const WRITES = [
  "families/dense-dashboards.json",
  "families/quiet-editorial.json",
  "glossary/term-2b4d6f.json",
  "glossary/term-7h9k3m.json",
  "glossary/term-9p4r6t.json",
  "glossary/term-c3e5g7.json",
  "guardrails.json",
  "projects/internal-dashboard/project.json",
  "projects/landing-redesign/directions.json",
  "projects/landing-redesign/project.json",
  "references/ref-20261101-a1b2c3.json",
  "references/ref-20261102-d4e5f6.json",
  "references/ref-20261103-g7h8j9.json",
  "references/ref-20261104-m2n3p4.json",
  "taste-profile.json",
];
const ADDED = WRITES.filter((path) => path.startsWith("glossary/"));

const noop = () => ({ changes: [], skipped: [] });

async function openOlder(library: string, options: OpenOptions = {}): Promise<Library> {
  return open(library, TEST_REGISTRY, { hostName: HOST, pid: PID, ...options });
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

const at = (library: string, path: string) => join(library, ...path.split("/"));

/** The library files on disk, without `.tastelib/`. */
async function libraryFiles(library: string): Promise<Map<string, Uint8Array>> {
  const files = await readTree(library);
  for (const path of [...files.keys()]) if (path.startsWith(".tastelib/")) files.delete(path);
  return files;
}

/** The migrated library: the bytes of every file after an uninterrupted migration of a copy. */
async function migratedFiles(): Promise<Map<string, Uint8Array>> {
  return withGoldenCopy(async (library) => {
    const result = await (await openOlder(library)).migrate({ clock });
    if (result.status !== "migrated") throw new Error(`the migration is ${result.status}`);
    return libraryFiles(library);
  });
}

/**
 * Options of a run through the faulty file system, with folder flushes on (a non-Windows platform).
 * Every run that injects the platform goes through it, with no fault when it needs none: it fakes
 * the folder flushes, which the real file system cannot do on Windows.
 */
function through(faults: FaultyFs, at?: LibraryWriteOptions["at"]): LibraryWriteOptions {
  return { clock, fs: faults.fs, platform: "linux", ...(at === undefined ? {} : { at }) };
}

/** The disk changes the run made to `path`, as the faulty file system recorded them. */
function changesTo(faults: FaultyFs, path: string): string[] {
  return faults.changes.filter((change) => change.endsWith(` ${path}`));
}

/** The backup was deleted in the order of step 7: its other files first, `owner.json` last, then the folder. */
function expectOwnerDeletedLast(faults: FaultyFs): void {
  const changes = faults.changes;
  const owner = changes.lastIndexOf(`unlink ${OWNER}`);
  expect(owner, "owner.json deleted").toBeGreaterThanOrEqual(0);
  const lastInBackup = changes.findLastIndex(
    (change) => change.startsWith("unlink ") && change.includes(`${BACKUP}/`),
  );
  expect(lastInBackup).toBe(owner);
  expect(changes.indexOf(`rmdir ${BACKUP}`, owner)).toBeGreaterThan(owner);
}

/**
 * What every cleaned-up stop leaves: no backup and no `.tastelib/` (this run created it), no
 * absolute path in the result, and a next write through the same handle that succeeds.
 */
async function expectCleanedUp(
  library: string,
  handle: Library,
  result: MigrateResult | WriteResult,
  migrated: boolean,
): Promise<void> {
  expect(await exists(at(library, BACKUP))).toBe(false);
  expect(await exists(at(library, ".tastelib"))).toBe(false);
  expect(JSON.stringify(result)).not.toContain(library);
  expect(await handle.write(noop, { clock })).toEqual({
    status: "unchanged",
    skipped: [],
    notices: migrated ? [] : [{ code: "migrated", from: 1, to: 2 }],
  });
}

describe("an I/O error after the claim undoes the migration and deletes the backup", () => {
  type Stage = {
    name: string;
    fault: (faults: FaultyFs) => void;
    failure: { operation: string; file: string; errno: string };
  };
  const stages: Stage[] = [
    {
      name: "writing owner.json, after its rename (its folder flush)",
      fault: (faults) => faults.inject({ operation: "sync", path: BACKUP, errno: "EIO" }),
      failure: { operation: "sync-folder", file: OWNER, errno: "EIO" },
    },
    {
      name: "writing a copy",
      fault: (faults) =>
        faults.inject({
          operation: "rename",
          path: `${BACKUP}/files/families/quiet-editorial.json`,
          errno: "ENOSPC",
        }),
      failure: {
        operation: "rename",
        file: `${BACKUP}/files/families/quiet-editorial.json`,
        errno: "ENOSPC",
      },
    },
    {
      name: "writing the manifest",
      fault: (faults) => faults.inject({ operation: "rename", path: MANIFEST, errno: "EIO" }),
      failure: { operation: "rename", file: MANIFEST, errno: "EIO" },
    },
    {
      name: "the first step-5 write, right after the manifest",
      fault: (faults) =>
        faults.inject({ operation: "rename", path: WRITES[0] as string, errno: "EIO" }),
      failure: { operation: "rename", file: WRITES[0] as string, errno: "EIO" },
    },
    {
      name: "a step-5 write after some others",
      fault: (faults) =>
        faults.inject({
          operation: "rename",
          path: "references/ref-20261102-d4e5f6.json",
          errno: "EIO",
        }),
      failure: { operation: "rename", file: "references/ref-20261102-d4e5f6.json", errno: "EIO" },
    },
    {
      name: "the deletion of a removed file",
      fault: (faults) =>
        faults.inject({ operation: "unlink", path: "glossary.json", errno: "EIO" }),
      failure: { operation: "unlink", file: "glossary.json", errno: "EIO" },
    },
    {
      name: "writing library.json, last",
      fault: (faults) => faults.inject({ operation: "rename", path: "library.json", errno: "EIO" }),
      failure: { operation: "rename", file: "library.json", errno: "EIO" },
    },
    {
      name: "the folder flush after a step-5 write (a failed write marked applied)",
      fault: (faults) => faults.inject({ operation: "sync", path: "families", errno: "EIO" }),
      failure: { operation: "sync-folder", file: WRITES[0] as string, errno: "EIO" },
    },
    {
      name: "marking the manifest done, before its rename",
      fault: (faults) =>
        faults.inject({ operation: "rename", path: MANIFEST, errno: "EIO", skip: 1 }),
      failure: { operation: "rename", file: MANIFEST, errno: "EIO" },
    },
  ];

  for (const stage of stages) {
    it(`at ${stage.name}: failed, byte for byte as before, no backup, no notice`, async () => {
      await withGoldenCopy(async (library) => {
        const before = await tree(library);
        const faults = faultyFs(library);
        stage.fault(faults);
        const handle = await openOlder(library);
        const result = await handle.migrate(through(faults));
        expect(faults.fired.length).toBe(1);
        expect(result).toEqual({
          status: "failed",
          failure: { code: "io-error", message: expect.any(String), ...stage.failure },
          notices: [],
        });
        expect(await tree(library)).toEqual(before);
        expectOwnerDeletedLast(faults);
        await expectCleanedUp(library, handle, result, false);
      });
    });
  }

  it("restores only the files already replaced or deleted, removes only the files it added, and never touches a file it had not reached", async () => {
    await withGoldenCopy(async (library) => {
      const before = await libraryFiles(library);
      const stopAt = "references/ref-20261102-d4e5f6.json";
      const faults = faultyFs(library);
      faults.inject({ operation: "rename", path: stopAt, errno: "EIO" });
      const { points, at: record } = recordPoints();
      const handle = await openOlder(library);
      const result = await handle.migrate(through(faults, record));
      expect(result.status).toBe("failed");
      const reached = WRITES.slice(0, WRITES.indexOf(stopAt));
      const restored = reached.filter((path) => !ADDED.includes(path));
      expect(points.filter((p) => p.startsWith("restored:") || p.startsWith("removed:"))).toEqual(
        reached.map((path) => `${ADDED.includes(path) ? "removed" : "restored"}:${path}`),
      );
      for (const path of restored) {
        expect(changesTo(faults, path), path).toEqual([`rename ${path}`, `rename ${path}`]);
      }
      for (const path of ADDED) {
        expect(changesTo(faults, path), path).toEqual([`rename ${path}`, `unlink ${path}`]);
      }
      // The folder the step created for the added files is removed again.
      expect(changesTo(faults, "glossary")).toEqual(["mkdir glossary", "rmdir glossary"]);
      for (const path of [...WRITES.slice(WRITES.indexOf(stopAt) + 1), "glossary.json"]) {
        expect(changesTo(faults, path), path).toEqual([]);
      }
      expect(changesTo(faults, "library.json")).toEqual([]);
      expect(await libraryFiles(library)).toEqual(before);
    });
  });

  it("restores a deleted file and library.json too when it stops after them", async () => {
    await withGoldenCopy(async (library) => {
      const before = await libraryFiles(library);
      const faults = faultyFs(library);
      // The manifest marked done is the second write of the manifest.
      faults.inject({ operation: "rename", path: MANIFEST, errno: "EIO", skip: 1 });
      const { points, at: record } = recordPoints();
      const result = await (await openOlder(library)).migrate(through(faults, record));
      expect(result).toMatchObject({ status: "failed", notices: [] });
      const undone = points.filter((p) => p.startsWith("restored:") || p.startsWith("removed:"));
      expect(undone.slice(-2)).toEqual(["restored:glossary.json", "restored:library.json"]);
      expect(changesTo(faults, "glossary.json")).toEqual([
        "unlink glossary.json",
        "rename glossary.json",
      ]);
      expect(await libraryFiles(library)).toEqual(before);
    });
  });

  it("keeps the library migrated after done: failed with the migrated notice, and the backup deleted", async () => {
    const migrated = await migratedFiles();
    await withGoldenCopy(async (library) => {
      const faults = faultyFs(library);
      faults.inject({
        operation: "unlink",
        path: `${BACKUP}/files/families/dense-dashboards.json`,
        errno: "EIO",
      });
      const handle = await openOlder(library);
      const result = await handle.migrate(through(faults));
      expect(result).toEqual({
        status: "failed",
        failure: {
          code: "io-error",
          operation: "unlink",
          file: `${BACKUP}/files/families/dense-dashboards.json`,
          errno: "EIO",
          message: expect.any(String),
        },
        notices: [{ code: "migrated", from: 1, to: 2 }],
      });
      expect(await libraryFiles(library)).toEqual(migrated);
      expectOwnerDeletedLast(faults);
      await expectCleanedUp(library, handle, result, true);
    });
  });

  it("keeps the library migrated when only the flush after the done rename fails (applied)", async () => {
    const migrated = await migratedFiles();
    await withGoldenCopy(async (library) => {
      const faults = faultyFs(library);
      const handle = await openOlder(library);
      const result = await handle.migrate(
        through(faults, (point) => {
          // The next flush of the backup folder is the one after the done rename.
          if (point === "library-json-written") {
            faults.inject({ operation: "sync", path: BACKUP, errno: "EIO" });
          }
        }),
      );
      expect(result).toMatchObject({
        status: "failed",
        failure: { operation: "sync-folder", file: MANIFEST, errno: "EIO" },
        notices: [{ code: "migrated", from: 1, to: 2 }],
      });
      expect(await libraryFiles(library)).toEqual(migrated);
      await expectCleanedUp(library, handle, result, true);
    });
  });

  it("keeps the migrated notice in a write whose gate migration failed after done", async () => {
    await withGoldenCopy(async (library) => {
      const faults = faultyFs(library);
      faults.inject({ operation: "unlink", path: MANIFEST, errno: "EIO" });
      const handle = await openOlder(library);
      let built = false;
      const result = await handle.write(() => {
        built = true;
        return noop();
      }, through(faults));
      expect(built).toBe(false);
      expect(result).toMatchObject({
        status: "failed",
        failure: { operation: "unlink", file: MANIFEST, errno: "EIO" },
        written: [],
        notWritten: [],
        notices: [{ code: "migrated", from: 1, to: 2 }],
      });
      await expectCleanedUp(library, handle, result, true);
    });
  });
});

describe("a file changed outside tastelib during the migration", () => {
  it("before its step-5 write: refused with write-conflict, the files before it restored, the changed file keeps its new bytes", async () => {
    await withGoldenCopy(async (library) => {
      const before = await libraryFiles(library);
      const changed = "projects/landing-redesign/project.json";
      const edited = `${decoder.decode(before.get(changed))} `;
      const faults = faultyFs(library);
      const handle = await openOlder(library);
      const result = await handle.migrate(
        through(faults, async (point) => {
          if (point === "wrote:guardrails.json") await writeFile(at(library, changed), edited);
        }),
      );
      expect(result).toMatchObject({
        status: "refused",
        issues: [{ severity: "error", code: "write-conflict", file: changed, pointer: null }],
        notices: [],
      });
      const after = await libraryFiles(library);
      expect(decoder.decode(after.get(changed))).toBe(edited);
      expect(changesTo(faults, changed)).toEqual([]);
      for (const [path, bytes] of before) {
        if (path !== changed) expect(after.get(path), path).toEqual(bytes);
      }
      expect([...after.keys()].filter((path) => path.startsWith("glossary/"))).toEqual([]);
      expect(await exists(at(library, BACKUP))).toBe(false);
      expectOwnerDeletedLast(faults);
      expect(JSON.stringify(result)).not.toContain(library);
      // The next write reads everything again and migrates from there.
      expect((await handle.write(noop, { clock })).notices).toEqual([
        { code: "migrated", from: 1, to: 2 },
      ]);
    });
  });

  for (const when of ["before-claim", "claimed"] as const) {
    it(`between step 1 and the re-read after the claim (at ${when}): write-conflict before the manifest, the backup deleted with owner.json last, no copy of the old bytes`, async () => {
      await withGoldenCopy(async (library) => {
        const changed = "references/ref-20261103-g7h8j9.json";
        const before = await libraryFiles(library);
        const edited = `${decoder.decode(before.get(changed))} `;
        const faults = faultyFs(library);
        const { points, at: record } = recordPoints();
        const handle = await openOlder(library);
        await handle.snapshot();
        const result = await handle.migrate(
          through(faults, async (point) => {
            record(point);
            if (point === when) await writeFile(at(library, changed), edited);
          }),
        );
        expect(result).toMatchObject({
          status: "refused",
          issues: [{ code: "write-conflict", file: changed }],
          notices: [],
        });
        expect(points).not.toContain("manifest-written");
        expect(changesTo(faults, MANIFEST)).toEqual([]);
        // No copy ever held the old bytes of the changed file; the copies before it were deleted.
        expect(changesTo(faults, `${BACKUP}/files/${changed}`)).toEqual([]);
        expect(changesTo(faults, `${BACKUP}/files/families/dense-dashboards.json`)).toEqual([
          `rename ${BACKUP}/files/families/dense-dashboards.json`,
          `unlink ${BACKUP}/files/families/dense-dashboards.json`,
        ]);
        expectOwnerDeletedLast(faults);
        expect(await exists(at(library, BACKUP))).toBe(false);
        expect(await exists(at(library, ".tastelib"))).toBe(false);
        const after = await libraryFiles(library);
        expect(decoder.decode(after.get(changed))).toBe(edited);
        for (const [path, bytes] of before) {
          if (path !== changed) expect(after.get(path), path).toEqual(bytes);
        }
        expect(JSON.stringify(result)).not.toContain(library);
      });
    });
  }
});

describe("a crash cleans up nothing", () => {
  const points = [
    "before-claim",
    "claimed",
    "owner-written",
    "copied:families/dense-dashboards.json",
    "manifest-written",
    "wrote:guardrails.json",
    "deleted:glossary.json",
    "library-json-written",
    "done-written",
  ];
  for (const point of points) {
    it(`at ${point}: the run throws, and the disk is exactly as the crash left it`, async () => {
      await withGoldenCopy(async (library) => {
        let atCrash: Record<string, string> | null = null;
        const handle = await openOlder(library);
        await expect(
          handle.migrate(
            through(faultyFs(library), async (reached) => {
              if (reached !== point) return;
              atCrash = await tree(library);
              throw new SimulatedCrash(point);
            }),
          ),
        ).rejects.toBeInstanceOf(SimulatedCrash);
        expect(await tree(library)).toEqual(atCrash);
        if (point !== "before-claim") expect(await exists(at(library, BACKUP))).toBe(true);
      });
    });
  }

  it("inside the cleanup: the backup and what is not undone yet stay", async () => {
    await withGoldenCopy(async (library) => {
      const faults = faultyFs(library);
      faults.inject({ operation: "rename", path: "library.json", errno: "EIO" });
      let atCrash: Record<string, string> | null = null;
      const handle = await openOlder(library);
      await expect(
        handle.migrate(
          through(faults, async (reached) => {
            if (reached !== "restored:families/quiet-editorial.json") return;
            atCrash = await tree(library);
            throw new SimulatedCrash(reached);
          }),
        ),
      ).rejects.toBeInstanceOf(SimulatedCrash);
      expect(await tree(library)).toEqual(atCrash);
      expect((await readJson(library, MANIFEST)).state).toBe("in-progress");
      expect((await readJson(library, "guardrails.json")).formatVersion).toBe(2);
    });
  });
});

describe("a cleanup that fails too is finished by the owning handle before its next write", () => {
  /**
   * Fails the manifest marked done, so the cleanup undoes every step-5 write, and fails the
   * cleanup's own write of `failAt`: the backup stays, owned by this process.
   */
  async function failTwice(library: string, failAt: string) {
    const faults = faultyFs(library);
    faults.inject({ operation: "rename", path: MANIFEST, errno: "EIO", skip: 1 });
    // An added file is removed by the cleanup; any other is renamed back, and a file step 5 wrote
    // was renamed once already.
    faults.inject({
      operation: ADDED.includes(failAt) ? "unlink" : "rename",
      path: failAt,
      errno: "EIO",
      skip: WRITES.includes(failAt) && !ADDED.includes(failAt) ? 1 : 0,
    });
    const handle = await openOlder(library);
    const result = await handle.migrate(through(faults));
    expect(faults.fired.length).toBe(2);
    expect(result).toMatchObject({
      status: "failed",
      failure: { operation: "rename", file: MANIFEST, errno: "EIO" },
      notices: [],
    });
    if (result.status === "failed") expect(result.failure.message).toContain("backup was kept");
    expect(JSON.stringify(result)).not.toContain(library);
    expect(await readJson(library, OWNER)).toEqual({
      pid: PID,
      host: HOST,
      claimedAt: NOW.toISOString(),
    });
    expect((await readJson(library, MANIFEST)).state).toBe("in-progress");
    return handle;
  }

  it("leaves the backup, which a second handle with another pid treats as live (write-conflict)", async () => {
    await withGoldenCopy(async (library) => {
      await failTwice(library, "glossary.json");
      const left = await tree(library);
      const other = await openOlder(library, { pid: PID + 1 });
      expect(await other.write(noop, { clock })).toMatchObject({
        status: "refused",
        issues: [{ code: "write-conflict", file: BACKUP }],
        notices: [],
      });
      expect(await other.migrate({ clock })).toMatchObject({
        status: "refused",
        issues: [{ code: "write-conflict", file: BACKUP }],
      });
      expect(await tree(library)).toEqual(left);
    });
  });

  it("finishes a cleanup that stopped at its first file: every file holds the runner's bytes and is restored or removed", async () => {
    await withGoldenCopy(async (library) => {
      const original = await libraryFiles(library);
      const handle = await failTwice(library, WRITES[0] as string);
      for (const path of ADDED) expect(await exists(at(library, path)), path).toBe(true);
      const { points, at: record } = recordPoints();
      let beforeClaim: Map<string, Uint8Array> | null = null;
      const result = await handle.write(
        noop,
        through(faultyFs(library), async (point) => {
          record(point);
          if (point === "before-claim") beforeClaim = await libraryFiles(library);
        }),
      );
      expect(result).toEqual({
        status: "unchanged",
        skipped: [],
        notices: [{ code: "migrated", from: 1, to: 2 }],
      });
      expect(beforeClaim).toEqual(original);
      const resumed = points.slice(0, points.indexOf("before-claim"));
      expect(resumed.filter((p) => p.startsWith("restored:") || p.startsWith("removed:"))).toEqual([
        ...WRITES.map((path) => `${ADDED.includes(path) ? "removed" : "restored"}:${path}`),
        "restored:glossary.json",
        "restored:library.json",
      ]);
      expect(resumed.at(-1)).toBe("owner-deleted");
      expect(await exists(at(library, BACKUP))).toBe(false);
    });
  });

  it("accepts files already restored or removed: an added file removed and the deleted file not yet restored", async () => {
    await withGoldenCopy(async (library) => {
      const original = await libraryFiles(library);
      const handle = await failTwice(library, "glossary.json");
      // The interrupted cleanup removed the added files and restored the changed ones, then
      // stopped at the deleted file: it is absent, and library.json still holds the runner's bytes.
      for (const path of ADDED) expect(await exists(at(library, path)), path).toBe(false);
      expect(await exists(at(library, "glossary.json"))).toBe(false);
      expect((await readJson(library, "library.json")).formatVersion).toBe(2);
      expect((await readJson(library, "guardrails.json")).formatVersion).toBe(1);
      const { points, at: record } = recordPoints();
      let beforeClaim: Map<string, Uint8Array> | null = null;
      const result = await handle.write(
        noop,
        through(faultyFs(library), async (point) => {
          record(point);
          if (point === "before-claim") beforeClaim = await libraryFiles(library);
        }),
      );
      expect(result).toMatchObject({
        status: "unchanged",
        notices: [{ code: "migrated", from: 1, to: 2 }],
      });
      expect(beforeClaim).toEqual(original);
      const resumed = points.slice(0, points.indexOf("before-claim"));
      expect(resumed.filter((p) => p.startsWith("restored:") || p.startsWith("removed:"))).toEqual([
        "restored:glossary.json",
        "restored:library.json",
      ]);
    });
  });

  it("accepts a deleted file that already holds the backup's bytes", async () => {
    await withGoldenCopy(async (library) => {
      const original = await libraryFiles(library);
      const handle = await failTwice(library, "glossary.json");
      await writeFile(at(library, "glossary.json"), original.get("glossary.json") as Uint8Array);
      const { points, at: record } = recordPoints();
      const result = await handle.migrate(through(faultyFs(library), record));
      expect(result).toMatchObject({ status: "migrated" });
      const resumed = points.slice(0, points.indexOf("before-claim"));
      expect(resumed.filter((p) => p.startsWith("restored:") || p.startsWith("removed:"))).toEqual([
        "restored:library.json",
      ]);
    });
  });

  it("accepts an added file that the user's tools already removed while it held the runner's bytes", async () => {
    await withGoldenCopy(async (library) => {
      const original = await libraryFiles(library);
      const handle = await failTwice(library, WRITES[0] as string);
      const { rm } = await import("node:fs/promises");
      await rm(at(library, ADDED[0] as string));
      let beforeClaim: Map<string, Uint8Array> | null = null;
      const result = await handle.write(
        noop,
        through(faultyFs(library), async (point) => {
          if (point === "before-claim") beforeClaim = await libraryFiles(library);
        }),
      );
      expect(result.status).toBe("unchanged");
      expect(beforeClaim).toEqual(original);
    });
  });

  it("flushes the folder of a file the interrupted cleanup already restored, and keeps the backup when that flush fails", async () => {
    await withGoldenCopy(async (library) => {
      const handle = await failTwice(library, "glossary.json");
      const left = await tree(library);
      const faults = faultyFs(library);
      faults.inject({ operation: "sync", path: "families", errno: "EIO" });
      const result = await handle.write(noop, through(faults));
      expect(result).toMatchObject({
        status: "failed",
        failure: { operation: "sync-folder", file: WRITES[0], errno: "EIO" },
      });
      expect(JSON.stringify(result)).not.toContain(library);
      expect(await tree(library)).toEqual(left);
      // Still pending: the next write finishes it.
      expect((await handle.write(noop, { clock })).status).toBe("unchanged");
      expect(await exists(at(library, BACKUP))).toBe(false);
    });
  });

  it("refuses with write-conflict and keeps the backup when owner.json no longer holds its bytes", async () => {
    await withGoldenCopy(async (library) => {
      const handle = await failTwice(library, "glossary.json");
      const owner = await readFile(at(library, OWNER), "utf8");
      await writeFile(
        at(library, OWNER),
        owner.replace(NOW.toISOString(), "2026-11-05T10:00:01.000Z"),
      );
      const left = await tree(library);
      const result = await handle.write(noop, through(faultyFs(library)));
      expect(result).toMatchObject({
        status: "refused",
        issues: [{ code: "write-conflict", file: BACKUP }],
        notices: [],
      });
      expect(await tree(library)).toEqual(left);
    });
  });

  it("refuses with write-conflict naming a file in any other state, changes nothing, keeps the backup, and finishes once the file is back", async () => {
    await withGoldenCopy(async (library) => {
      const original = await libraryFiles(library);
      const handle = await failTwice(library, "glossary.json");
      const runnerBytes = await readFile(at(library, "library.json"));
      await writeFile(at(library, "library.json"), `${runnerBytes.toString("utf8")} `);
      const left = await tree(library);
      const result = await handle.write(noop, through(faultyFs(library)));
      expect(result).toMatchObject({
        status: "refused",
        issues: [{ code: "write-conflict", file: "library.json" }],
        notices: [],
      });
      expect(JSON.stringify(result)).not.toContain(library);
      // Nothing was restored before the refusal: the deleted file is still absent.
      expect(await tree(library)).toEqual(left);
      // Once the file is back in a state the cleanup accepts, the next write finishes it.
      await writeFile(at(library, "library.json"), runnerBytes);
      let beforeClaim: Map<string, Uint8Array> | null = null;
      const next = await handle.write(noop, {
        clock,
        at: async (point) => {
          if (point === "before-claim") beforeClaim = await libraryFiles(library);
        },
      });
      expect(next.status).toBe("unchanged");
      expect(beforeClaim).toEqual(original);
    });
  });

  it("refuses an added file whose bytes changed, and a replaced file that holds neither the runner's nor the backup's bytes", async () => {
    for (const [failAt, edit] of [
      [WRITES[0] as string, ADDED[1] as string],
      ["glossary.json", "guardrails.json"],
    ] as const) {
      await withGoldenCopy(async (library) => {
        const handle = await failTwice(library, failAt);
        await writeFile(at(library, edit), "{}\n");
        const left = await tree(library);
        const result = await handle.write(noop, through(faultyFs(library)));
        expect(result, edit).toMatchObject({
          status: "refused",
          issues: [{ code: "write-conflict", file: edit }],
        });
        expect(await tree(library)).toEqual(left);
      });
    }
  });
});
