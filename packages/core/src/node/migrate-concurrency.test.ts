import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { recordPoints } from "../../test/support/crash.js";
import { readTree, withGoldenCopy } from "../../test/support/golden.js";
import { type Json, open, tree } from "../../test/support/library.js";
import { type Pause, pauseAt } from "../../test/support/pause.js";
import { TEST_REGISTRY } from "../../test/support/registry.js";
import type { Library } from "./open.js";
import type { Build, LibraryWriteOptions } from "./write.js";

/**
 * Concurrent migrations and writes in one process (docs/design.md section 15, "Core test
 * approach", "Concurrency"; format-spec §15.3 step 4 and recovery case 1 and 3). The `at` hook
 * returns a promise, so a test pauses a run at a named point of the runner, lets another handle
 * run, then resumes the first. Run with the test-only version 2 and the golden v1 library. The
 * handles use the real host name and process id, so the migrating owner is alive, as it is in
 * another process that is still running.
 */

const NOW = new Date("2026-11-05T10:00:00.000Z");
const clock = () => NOW;
const BACKUP = ".tastelib/migration-backup";

/** The points of the replace primitive, which the runner's own points are read without. */
const PRIMITIVE_POINTS = new Set(["temp-written", "before-rename", "before-unlink"]);

/** The files the golden library's migration copies into the backup, in the order it copies them. */
const COPIED = [
  "families/dense-dashboards.json",
  "families/quiet-editorial.json",
  "glossary.json",
  "guardrails.json",
  "library.json",
  "projects/internal-dashboard/project.json",
  "projects/landing-redesign/directions.json",
  "projects/landing-redesign/project.json",
  "references/ref-20261101-a1b2c3.json",
  "references/ref-20261102-d4e5f6.json",
  "references/ref-20261103-g7h8j9.json",
  "references/ref-20261104-m2n3p4.json",
  "taste-profile.json",
];

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

/** A handle with the test registry and the real owner (this process's host name and id). */
const openHandle = (library: string): Promise<Library> => open(library, TEST_REGISTRY);

/** Runs every hook in turn; the first that pauses holds the run. */
function both(...pauses: Pause[]): LibraryWriteOptions["at"] {
  return (point) => {
    for (const pause of pauses) {
      const waiting = pause.at(point);
      if (waiting !== undefined) return waiting;
    }
    return undefined;
  };
}

/** A build that counts its calls and changes nothing. */
function countingBuild(): { build: Build; calls: () => number } {
  let calls = 0;
  return {
    build: () => {
      calls++;
      return { changes: [], skipped: [] };
    },
    calls: () => calls,
  };
}

/** A build that changes the text of the first guardrail, so a write has something to write. */
const editGuardrail: Build = (snapshot) => {
  const guardrails = structuredClone(snapshot.files.get("guardrails.json")?.value) as Json;
  guardrails.guardrails[0].rule.content.text = "No banners that compete with the content.";
  return { changes: [{ path: "guardrails.json", next: guardrails }], skipped: [] };
};

/** The library files after an uninterrupted migration of a fresh copy. */
async function migratedFiles(): Promise<Map<string, Uint8Array>> {
  return withGoldenCopy(async (library) => {
    const result = await (await openHandle(library)).migrate({ clock });
    if (result.status !== "migrated") throw new Error(`the migration is ${result.status}`);
    return readTree(library);
  });
}

/** A write refused by the gate because a migration backup exists: nothing written, no notice. */
const refusedAtBackup = {
  status: "refused",
  issues: [expect.objectContaining({ code: "write-conflict", severity: "error", file: BACKUP })],
  written: [],
  notWritten: [],
  skipped: [],
  notices: [],
};

describe("two handles migrating the same library", () => {
  it("both paused before the claim, then resumed together: exactly one claims and finishes, the other gets write-conflict with no notice and touches nothing", async () => {
    const migrated = await migratedFiles();
    await withGoldenCopy(async (library) => {
      // A run that wins the claim waits there until the test has seen the other one end, so the
      // other can only have met the claim, never a backup already deleted.
      const contenders = await Promise.all(
        [1, 2].map(async () => {
          const handle = await openHandle(library);
          const beforeClaim = pauseAt("before-claim");
          const claimed = pauseAt("claimed");
          const counted = countingBuild();
          const run = handle.write(counted.build, { clock, at: both(beforeClaim, claimed) });
          return { handle, beforeClaim, claimed, counted, run };
        }),
      );
      await Promise.all(contenders.map(({ beforeClaim }) => beforeClaim.reached));
      // Both have passed the gate's look for the backup and planned on the library at version 1.
      const before = await tree(library);
      expect(await exists(join(library, ".tastelib"))).toBe(false);
      for (const { beforeClaim } of contenders) beforeClaim.release();

      const first = await Promise.race([
        ...contenders.map((contender) => contender.run.then(() => contender)),
        Promise.all(contenders.map(({ claimed }) => claimed.reached)).then(() => null),
      ]);
      if (first === null) throw new Error("Both runs claimed the backup folder.");
      const loser = first;
      const winner = contenders.find((contender) => contender !== loser);
      if (winner === undefined) throw new Error("There is no other run.");
      await winner.claimed.reached;
      expect(await loser.run).toEqual(refusedAtBackup);
      expect(loser.counted.calls()).toBe(0);
      // Only the winner's claim is there: an empty backup folder in `.tastelib/`.
      expect(await tree(library)).toEqual({
        ...before,
        ".tastelib/": "",
        ".tastelib/migration-backup/": "",
      });

      winner.claimed.release();
      expect(await winner.run).toEqual({
        status: "unchanged",
        skipped: [],
        notices: [{ code: "migrated", from: 1, to: 2 }],
      });
      expect(winner.counted.calls()).toBe(1);
      expect(await exists(join(library, BACKUP))).toBe(false);
      expect(await readTree(library)).toEqual(migrated);
      // The loser's next write finds the migrated library: no migration, no notice.
      expect(await loser.handle.write(loser.counted.build, { clock })).toEqual({
        status: "unchanged",
        skipped: [],
        notices: [],
      });
    });
  });

  it("one resumed only after the other finished claims an empty folder, finds the files changed since it read them, refuses with write-conflict and leaves the migrated library as it is", async () => {
    const migrated = await migratedFiles();
    await withGoldenCopy(async (library) => {
      const first = await openHandle(library);
      const second = await openHandle(library);
      const late = pauseAt("before-claim");
      const { points, at: record } = recordPoints();
      const lateRun = second.migrate({
        clock,
        at: (point) => {
          record(point);
          return late.at(point);
        },
      });
      await late.reached;
      expect(await first.migrate({ clock })).toMatchObject({ status: "migrated" });
      const after = await tree(library);
      late.release();
      expect(await lateRun).toEqual({
        status: "refused",
        issues: [expect.objectContaining({ code: "write-conflict", file: COPIED[0] })],
        notices: [],
      });
      // It stopped at its first copy, before copying anything, and deleted its backup.
      expect(points.filter((point) => !PRIMITIVE_POINTS.has(point))).toEqual([
        "before-claim",
        "claimed",
        "owner-written",
        "owner-deleted",
      ]);
      expect(await tree(library)).toEqual(after);
      expect(await readTree(library)).toEqual(migrated);
    });
  });
});

describe("a writer that meets a migration under way", () => {
  const points = [
    ["claimed", "no owner.json yet"],
    ["owner-written", "owner.json and no copy"],
    [`copied:${COPIED[0]}`, "the first copy"],
    [`copied:${COPIED[COPIED.length - 1]}`, "every copy and no manifest"],
  ] as const;

  it.each(points)(
    "paused at %s (%s): the writer gets write-conflict, its build never runs, and the backup and the library stay untouched; the migration then finishes",
    async (point) => {
      const migrated = await migratedFiles();
      await withGoldenCopy(async (library) => {
        const owner = await openHandle(library);
        const pause = pauseAt(point);
        const migration = owner.migrate({ clock, at: pause.at });
        await pause.reached;
        const during = await tree(library);
        expect(Object.keys(during)).toContain(`${BACKUP}/`);

        const writer = await openHandle(library);
        const { build, calls } = countingBuild();
        // The gate's look for the backup stops the writer: it never plans a migration of its own.
        const { points, at: record } = recordPoints();
        expect(await writer.write(build, { clock, at: record })).toEqual(refusedAtBackup);
        expect(await writer.migrate({ clock, at: record })).toEqual({
          status: "refused",
          issues: [expect.objectContaining({ code: "write-conflict", file: BACKUP })],
          notices: [],
        });
        expect(calls()).toBe(0);
        expect(points).toEqual([]);
        expect(await tree(library)).toEqual(during);

        pause.release();
        expect(await migration).toMatchObject({ status: "migrated", from: 1, to: 2 });
        expect(await readTree(library)).toEqual(migrated);
        // Once the backup is gone, the writer's next write goes through, with no notice of its own.
        expect(await writer.write(editGuardrail, { clock })).toEqual({
          status: "written",
          written: ["guardrails.json"],
          skipped: [],
          notices: [],
        });
      });
    },
  );
});
