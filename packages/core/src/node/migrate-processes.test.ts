import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { describe, expect, it } from "vitest";
import { readTree, withGoldenCopy } from "../../test/support/golden.js";
import { type Json, tree } from "../../test/support/library.js";

/**
 * Eight real processes race for the migration claim, the non-recursive `mkdir` of
 * `.tastelib/migration-backup/` (format-spec §15.3 step 4; docs/design.md section 15, "Core test
 * approach", "Concurrency"): only the operating system can show that exactly one wins. Each process
 * runs `test/processes/migrate.mjs`, which imports the built `dist/` (the `test` script builds
 * first) and migrates the golden v1 library to a tiny version 2 that only sets `formatVersion` 2.
 * Every process waits at the runner's `before-claim` point until all have planned, and the winner
 * waits at `claimed` until every other has ended, so the outcome never depends on timing.
 */

const PROCESSES = 8;
const BACKUP = ".tastelib/migration-backup";
const CORE = join(import.meta.dirname, "..", "..");
const DRIVER = join(CORE, "test", "processes", "migrate.mjs");
const DIST = join(CORE, "dist", "index.js");

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

/** One driver process: the events it printed, its stderr, and a way to wait for an event. */
interface Driver {
  child: ChildProcessWithoutNullStreams;
  events: Json[];
  stderr: () => string;
  /** The first event, printed or still to come, whose name is one of `names`; rejects if the process ends first. */
  next: (...names: string[]) => Promise<Json>;
  exited: Promise<number | null>;
}

function startDriver(library: string): Driver {
  const child = spawn(process.execPath, [DRIVER, library], { windowsHide: true });
  // A driver that already ended cannot be written to; its exit is what the test reports.
  child.stdin.on("error", () => undefined);
  const events: Json[] = [];
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const listeners: { names: string[]; resolve: (event: Json) => void }[] = [];
  createInterface({ input: child.stdout }).on("line", (line) => {
    const event = JSON.parse(line) as Json;
    events.push(event);
    for (const listener of [...listeners]) {
      if (listener.names.includes(event.event)) {
        listeners.splice(listeners.indexOf(listener), 1);
        listener.resolve(event);
      }
    }
  });
  const exited = new Promise<number | null>((resolve) => child.on("close", resolve));
  const state = () =>
    `pid ${child.pid}: events ${JSON.stringify(events)}, stderr ${JSON.stringify(stderr)}`;
  return {
    child,
    events,
    stderr: () => stderr,
    exited,
    next: (...names) => {
      const seen = events.find((event) => names.includes(event.event));
      if (seen !== undefined) return Promise.resolve(seen);
      return new Promise<Json>((resolve, reject) => {
        listeners.push({ names, resolve });
        void exited.then((code) =>
          reject(
            new Error(`The driver ended (exit ${code}) before ${names.join(" or ")}: ${state()}`),
          ),
        );
      });
    },
  };
}

/** The bytes of a golden file after the tiny version 2: `formatVersion` 2, in the same place. */
function atVersion2(bytes: Uint8Array): Uint8Array {
  const value = JSON.parse(new TextDecoder().decode(bytes)) as Json;
  return new TextEncoder().encode(`${JSON.stringify({ ...value, formatVersion: 2 }, null, 2)}\n`);
}

describe("processes racing for the migration claim", () => {
  it(`${PROCESSES} processes plan on version 1, then claim at once: exactly one migrates, the others get write-conflict, touch nothing and give no notice`, async () => {
    expect(existsSync(DIST), `${DIST} is missing: build core first (its test script does)`).toBe(
      true,
    );
    await withGoldenCopy(async (library) => {
      const original = await readTree(library);
      const before = await tree(library);
      const drivers: Driver[] = [];
      try {
        for (let i = 0; i < PROCESSES; i++) drivers.push(startDriver(library));
        await Promise.all(drivers.map((driver) => driver.next("ready")));
        expect(await exists(join(library, ".tastelib"))).toBe(false);
        for (const driver of drivers) driver.child.stdin.write("go\n");

        // Each one either wins and waits at `claimed`, or ends.
        const first = await Promise.all(drivers.map((driver) => driver.next("claimed", "result")));
        const winners = drivers.filter((_, i) => first[i].event === "claimed");
        expect(winners.length, JSON.stringify(first)).toBe(1);
        for (const [i, event] of first.entries()) {
          if (event.event !== "result") continue;
          expect(event.result, `process ${i}`).toEqual({
            status: "refused",
            issues: [expect.objectContaining({ code: "write-conflict", file: BACKUP })],
            notices: [],
          });
        }
        // Only the winner's claim is on disk: the losers left nothing, and wrote no file.
        expect(await tree(library)).toEqual({
          ...before,
          ".tastelib/": "",
          ".tastelib/migration-backup/": "",
        });

        const [winner] = winners;
        if (winner === undefined) throw new Error("No process claimed the backup folder.");
        winner.child.stdin.write("finish\n");
        const won = await winner.next("result");
        expect(won.result, winner.stderr()).toMatchObject({
          status: "migrated",
          from: 1,
          to: 2,
          added: [],
          removed: [],
          notices: [{ code: "migrated", from: 1, to: 2 }],
        });
        expect(won.result.changed).toEqual([...original.keys()]);
        const codes = await Promise.all(drivers.map((driver) => driver.exited));
        expect(codes, drivers.map((driver) => driver.stderr()).join("\n")).toEqual(
          drivers.map(() => 0),
        );

        expect(await exists(join(library, BACKUP))).toBe(false);
        const migrated = await readTree(library);
        expect([...migrated.keys()]).toEqual([...original.keys()]);
        for (const [path, bytes] of original) {
          expect(migrated.get(path), path).toEqual(atVersion2(bytes));
        }
      } finally {
        for (const driver of drivers) {
          if (driver.child.exitCode === null && driver.child.signalCode === null)
            driver.child.kill();
        }
        await Promise.all(drivers.map((driver) => driver.exited));
      }
    });
  }, 60_000);
});
