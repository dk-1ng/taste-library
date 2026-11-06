import { statSync } from "node:fs";
import { mkdir, open, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withTempDir } from "@tastelib/testkit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Fastest, fastestOf, type TimedRun } from "../../test/support/fastest.js";
import { type Generated, generateLibrary } from "../../test/support/generate.js";
import type { Json } from "../../test/support/library.js";
import type { Snapshot } from "../validation/library.js";
import { type Library, type OpenOptions, openLibrary } from "./open.js";
import { readLibraryFileBytes } from "./read-file.js";
import type { StatFn } from "./refresh.js";

/**
 * The performance budget of the index (docs/design.md section 4, "Index", "Performance budget";
 * section 15, "Core test approach"): a library generated with a fixed seed (not timed), opened
 * once to warm up, then each budget line timed three times, and the fastest run checked (so are
 * its baselines). It runs alone, after every other test file of `core` (`vitest.config.ts`).
 *
 * The maintainer's decision (#36): a line passes when it meets its absolute budget, or when it
 * stays within a bounded overhead over a baseline measured in the same run on the same files,
 * just before the line. So a CI runner slower than the computers the budget is promised for
 * passes as long as the code adds no more than the bound over what the runner itself costs.
 */

/** The absolute budget of each line (docs/design.md section 4, "Index"). */
const OPEN_BUDGET_MS = 5000;
const REFRESH_BUDGET_MS = 500;
const WRITE_BUDGET_MS = 1000;

/*
 * The relative bound of each line: `factor × baseline + overhead`. These are starting values, to
 * be set from the timings of a CI run on Linux, Windows and macOS (every failure message and the
 * log of every run print them).
 */
/** Opening, over a plain read and `JSON.parse` of every file with 16 reads in flight. */
const OPEN_FACTOR = 15;
const OPEN_OVERHEAD_MS = 500;
/** A refresh, over a plain `stat` of every file with 16 in flight. */
const REFRESH_FACTOR = 1.5;
const REFRESH_OVERHEAD_MS = 100;
/** One write, over a plain `stat` of every file plus one plain durable write of the same bytes. */
const WRITE_FACTOR = 1.5;
const WRITE_OVERHEAD_MS = 100;

/**
 * How many times each budget line, and each baseline, is timed. Noise on a shared runner only adds
 * time, so the fastest run is the fair measure of the code, while a real regression shows in all
 * of them (the maintainer's decision, #84).
 */
const RUNS = 3;

const SETUP_MS = 600_000;
/** A line's own Vitest timeout: its baselines and its `RUNS` runs, on the slowest runner. */
const LINE_MS = 600_000;
const IN_FLIGHT = 16;

let root = "";
let scratch = "";
let generated: Generated;
let library: Library;
let finish: () => void = () => undefined;
let removed: Promise<unknown> = Promise.resolve();

/** The time spent in one kind of file-system call, from the first start to the last end. */
class Phase {
  calls = 0;
  private first = Number.POSITIVE_INFINITY;
  private last = Number.NEGATIVE_INFINITY;

  reset(): void {
    this.calls = 0;
    this.first = Number.POSITIVE_INFINITY;
    this.last = Number.NEGATIVE_INFINITY;
  }

  async time<T>(call: () => Promise<T>): Promise<T> {
    const start = performance.now();
    this.calls++;
    this.first = Math.min(this.first, start);
    try {
      return await call();
    } finally {
      this.last = Math.max(this.last, performance.now());
    }
  }

  describe(name: string): string {
    const span = this.calls === 0 ? 0 : this.last - this.first;
    return `${name} ${this.calls} calls over ${Math.round(span)} ms`;
  }
}

const phases = { listing: new Phase(), stat: new Phase(), reads: new Phase() };

/** `openLibrary`'s file-system options, timing each call. */
const timedOptions: OpenOptions = {
  readdir: (async (...args: unknown[]) =>
    // biome-ignore lint/suspicious/noExplicitAny: forwards the real call
    phases.listing.time(() => (readdir as any)(...args))) as typeof readdir,
  stat: ((path, options) => phases.stat.time(() => stat(path, options))) satisfies StatFn,
  readFile: (path, file) => phases.reads.time(() => readLibraryFileBytes(path, file)),
};

function resetPhases(): void {
  for (const phase of Object.values(phases)) phase.reset();
}

function describePhases(): string {
  return `${phases.listing.describe("listing")}; ${phases.stat.describe("stat")}; ${phases.reads.describe("reads")}`;
}

/** Runs `fn` once and returns how long it took, in milliseconds. */
async function timed<T>(fn: () => Promise<T>): Promise<{ ms: number; value: T }> {
  const start = performance.now();
  const value = await fn();
  return { ms: performance.now() - start, value };
}

/** What a timed line gives back besides its result: where its time went. */
interface Line<T> {
  result: T;
  phases: string;
}

/** Times `fn` with the file-system phases reset first, keeping the phases it spent. */
async function timedLine<T>(fn: () => Promise<T>): Promise<TimedRun<Line<T>>> {
  resetPhases();
  const { ms, value } = await timed(fn);
  return { ms, value: { result: value, phases: describePhases() } };
}

/** The fastest of `RUNS` runs of `fn`, in milliseconds (a baseline, kept the way a line is). */
async function fastestMs(fn: (attempt: number) => Promise<unknown>): Promise<number> {
  return (await fastestOf(RUNS, (attempt) => timed(() => fn(attempt)))).fastest.ms;
}

const paths = (): string[] => generated.files.map((file) => join(root, ...file.split("/")));

/**
 * Runs `fn` over `items` with `IN_FLIGHT` workers. Written here on purpose: the baselines
 * must not share code with the production scan, or a slowdown there would move both sides.
 */
async function pool<T, R>(items: readonly T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: IN_FLIGHT }, worker));
  return results;
}

/** Baselines measured on the same files, just before a line: the fastest of `RUNS` runs each. */
interface Baselines {
  /** `fs.promises.stat` of every file, 16 in flight. */
  statScanMs: number;
  /** `statSync` of every file, one after the other. */
  statSyncMs: number;
  /** `readFile` and `JSON.parse` of every file, 16 reads in flight (opening only). */
  readParseMs?: number;
  /** One write of a reference's bytes to a temporary file, `fsync`, rename (writing only). */
  durableWriteMs?: number;
}

async function measureBaselines(extra: { readParse?: boolean; durableWrite?: boolean }) {
  const files = paths();
  const out: Baselines = {
    statScanMs: await fastestMs(() => pool(files, (path) => stat(path))),
    statSyncMs: await fastestMs(async () => {
      for (const path of files) statSync(path);
    }),
  };
  if (extra.readParse) {
    out.readParseMs = await fastestMs(() =>
      pool(files, async (path) => JSON.parse(await readFile(path, "utf8"))),
    );
  }
  if (extra.durableWrite) {
    const bytes = await readFile(join(root, "references", `${generated.references[2]}.json`));
    // A target of its own in each run: a rename onto a file just written and closed can fail on
    // Windows while a scanner holds it, and the baseline has no retry like the production write.
    out.durableWriteMs = await fastestMs(async (attempt) => {
      const temporary = join(scratch, ".reference.json.tmp");
      const handle = await open(temporary, "wx");
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, join(scratch, `reference-${attempt}.json`));
    });
  }
  return out;
}

function describeBaselines(baselines: Baselines): string {
  const parts = [
    `plain stat scan (${IN_FLIGHT} in flight) ${Math.round(baselines.statScanMs)} ms`,
    `statSync loop ${Math.round(baselines.statSyncMs)} ms`,
  ];
  if (baselines.readParseMs !== undefined) {
    parts.push(`plain read and JSON.parse ${Math.round(baselines.readParseMs)} ms`);
  }
  if (baselines.durableWriteMs !== undefined) {
    parts.push(`plain durable write ${Math.round(baselines.durableWriteMs)} ms`);
  }
  return `${parts.join("; ")} (each the fastest of ${RUNS} runs)`;
}

/**
 * Whether a line passes: its fastest run is under its absolute budget, or within
 * `factor × baseline + overhead`. The message says all the times, which one was checked, both
 * bounds, the phases of the checked run and the baselines, and is logged on every run, so the
 * factors can be set from a CI run.
 */
function judge(
  line: string,
  checked: Fastest<Line<unknown>>,
  budgetMs: number,
  bound: { baselineMs: number; baseline: string; factor: number; overheadMs: number },
  baselines: Baselines,
): { pass: boolean; message: string } {
  const ms = checked.fastest.ms;
  const times = checked.runs.map((run) => `${Math.round(run.ms)} ms`).join(", ");
  const relativeMs = bound.factor * bound.baselineMs + bound.overheadMs;
  const pass = ms < budgetMs || ms <= relativeMs;
  const message =
    `${line} took ${times} (run ${checked.index + 1} of ${checked.runs.length}, the fastest, ` +
    `${Math.round(ms)} ms, is checked): the budget is ${budgetMs} ms, the relative bound ` +
    `${Math.round(relativeMs)} ms (${bound.factor} × ${bound.baseline} ${Math.round(bound.baselineMs)} ms + ` +
    `${bound.overheadMs} ms). Phases of the checked run: ${checked.fastest.value.phases}. Baselines: ${describeBaselines(baselines)}.`;
  console.log(`[budget] ${pass ? "pass" : "FAIL"}: ${message}`);
  return { pass, message };
}

async function snap(): Promise<Snapshot> {
  const result = await library.snapshot();
  if (!result.ok) throw new Error(result.message);
  return result.snapshot;
}

beforeAll(async () => {
  const ready = new Promise<string>((resolve) => {
    removed = withTempDir(async (dir) => {
      resolve(dir);
      await new Promise<void>((done) => {
        finish = done;
      });
    });
  });
  const dir = await ready;
  root = join(dir, "library");
  scratch = join(dir, "scratch");
  await mkdir(scratch);
  generated = await generateLibrary(root, {
    references: 5000,
    families: 50,
    membersPerFamily: 100,
    terms: 300,
    seed: 20261105,
  });
  // Warm-up, not timed.
  const warm = await openLibrary(root);
  if (!warm.ok) throw new Error(warm.message);
}, SETUP_MS);

afterAll(async () => {
  finish();
  await removed;
}, SETUP_MS);

describe("the performance budget, on 5000 generated references", () => {
  it(
    "opens the library in under 5 seconds, or within its bound over a plain read",
    async () => {
      const baselines = await measureBaselines({ readParse: true });
      const checked = await fastestOf(RUNS, () => timedLine(() => openLibrary(root, timedOptions)));
      for (const run of checked.runs) {
        if (!run.value.result.ok) throw new Error(run.value.result.message);
      }
      const opened = checked.fastest.value.result;
      if (!opened.ok) throw new Error(opened.message);
      library = opened.library;
      const { pass, message } = judge(
        "opening",
        checked,
        OPEN_BUDGET_MS,
        {
          baselineMs: baselines.readParseMs ?? 0,
          baseline: "plain read and JSON.parse",
          factor: OPEN_FACTOR,
          overheadMs: OPEN_OVERHEAD_MS,
        },
        baselines,
      );
      expect(pass, message).toBe(true);
    },
    LINE_MS,
  );

  it(
    "refreshes in under 0.5 seconds when nothing changed, or within its bound over a stat scan, returning the same snapshot",
    async () => {
      const before = await snap();
      const baselines = await measureBaselines({});
      const checked = await fastestOf(RUNS, () => timedLine(() => snap()));
      const { pass, message } = judge(
        "the refresh with nothing changed",
        checked,
        REFRESH_BUDGET_MS,
        {
          baselineMs: baselines.statScanMs,
          baseline: "plain stat scan",
          factor: REFRESH_FACTOR,
          overheadMs: REFRESH_OVERHEAD_MS,
        },
        baselines,
      );
      expect(pass, message).toBe(true);
      for (const run of checked.runs) expect(run.value.result).toBe(before);
      expect(before.index.references.size).toBe(5000);
    },
    LINE_MS,
  );

  it(
    "refreshes in under 0.5 seconds after one reference changed, or within its bound over a stat scan, with the index updated",
    async () => {
      const before = await snap();
      const inbox = [...before.index.references.values()].find((r) => r.state === "inbox");
      if (inbox === undefined) throw new Error("no reference in the inbox");
      const path = join(root, "references", `${inbox.id}.json`);
      const value: Json = JSON.parse(await readFile(path, "utf8"));
      const baselines = await measureBaselines({});
      // Each run changes the file again, from outside (another process), then times the refresh.
      // An agent proposes an interpretation of p0; the summary grows by one character per run, so
      // the size of the file, and with it its fingerprint, differs from the one before.
      const checked = await fastestOf(RUNS, async (attempt) => {
        value.interpretations.p0 = {
          origin: "agent",
          proposedBy: "claude-code",
          proposedAt: "2026-11-05T09:00:00.000Z",
          inputSha256: "0".repeat(64),
          proposal: {
            summary: `A calm page${".".repeat(attempt + 1)}`,
            vocabulary: [],
            keywords: [],
            screenTypes: [],
            components: [],
            aspects: [],
          },
          status: "to-review",
          correction: null,
          reviewedAt: null,
        };
        await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
        const run = await timedLine(() => snap());
        // The index has the change of this run, whichever run is the fastest.
        expect(run.value.result.index.references.get(inbox.id)?.state).toBe("processed");
        const file = run.value.result.files.get(`references/${inbox.id}.json`);
        expect((file?.value as Json | undefined)?.interpretations.p0.proposal.summary).toBe(
          `A calm page${".".repeat(attempt + 1)}`,
        );
        return run;
      });
      const { pass, message } = judge(
        "the refresh after one change",
        checked,
        REFRESH_BUDGET_MS,
        {
          baselineMs: baselines.statScanMs,
          baseline: "plain stat scan",
          factor: REFRESH_FACTOR,
          overheadMs: REFRESH_OVERHEAD_MS,
        },
        baselines,
      );
      expect(pass, message).toBe(true);
    },
    LINE_MS,
  );

  it(
    "writes one reference in under 1 second, gate and fsync included, or within its bound over a stat scan and a plain write",
    async () => {
      const id = generated.references[1] as string;
      const baselines = await measureBaselines({ durableWrite: true });
      // Each run edits the reference again, so each one is a real write. A write refreshes the
      // library first, and the write of the run before left a file not yet settled in the cache,
      // so that refresh would recompute the whole index: only the first run would measure "nothing
      // changed, gate, write". So the library is settled, untimed, before each run, and each run
      // checks that the write it timed started from that settled snapshot.
      let settled: Snapshot | undefined;
      const startedFrom: boolean[] = [];
      const checked = await fastestOf(RUNS, async () => {
        settled = await snap();
        return timedLine(() =>
          library.write((snapshot) => {
            startedFrom.push(snapshot === settled);
            const file = snapshot.files.get(`references/${id}.json`);
            const next = structuredClone(file?.value) as Json;
            next.note = `${next.note} Edited.`;
            return { changes: [{ path: `references/${id}.json`, next }], skipped: [] };
          }),
        );
      });
      expect(startedFrom, "every write starts from the settled snapshot").toEqual(
        Array(RUNS).fill(true),
      );
      for (const run of checked.runs) expect(run.value.result.status).toBe("written");
      const { pass, message } = judge(
        "the write",
        checked,
        WRITE_BUDGET_MS,
        {
          baselineMs: baselines.statScanMs + (baselines.durableWriteMs ?? 0),
          baseline: "(plain stat scan + plain durable write)",
          factor: WRITE_FACTOR,
          overheadMs: WRITE_OVERHEAD_MS,
        },
        baselines,
      );
      expect(pass, message).toBe(true);
    },
    LINE_MS,
  );
});
