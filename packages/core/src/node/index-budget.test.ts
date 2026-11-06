import { mkdir, open, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withTempDir } from "@tastelib/testkit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Fastest, interleaved, type TimedRun } from "../../test/support/fastest.js";
import { type Generated, generateLibrary } from "../../test/support/generate.js";
import type { Json } from "../../test/support/library.js";
import type { Snapshot } from "../validation/library.js";
import { type Library, type OpenOptions, openLibrary } from "./open.js";
import { readLibraryFileBytes } from "./read-file.js";
import type { StatFn } from "./refresh.js";

/**
 * The performance budget of the index (docs/design.md section 4, "Index", "Performance budget";
 * section 15, "Core test approach"): a library generated with a fixed seed (not timed), opened
 * once to warm up, then each budget line timed three times, and the fastest run checked. The
 * baselines are timed right before each run of the line, one attempt after the other, and the
 * fastest of each is checked too. Runs are checked without instrumentation; one more run of each
 * line, never checked, logs where the time went. It runs alone, after every other test file of
 * `core` (`vitest.config.ts`).
 *
 * The maintainer's decision (#36): a line passes when it meets its absolute budget, or when it
 * stays within a bounded overhead over a baseline measured in the same run on the same files,
 * right next to the line. So a CI runner slower than the computers the budget is promised for
 * passes as long as the code adds no more than the bound over what the runner itself costs.
 */

/** The absolute budget of each line (docs/design.md section 4, "Index"). */
const OPEN_BUDGET_MS = 5000;
const REFRESH_BUDGET_MS = 500;
const WRITE_BUDGET_MS = 1000;

/*
 * The relative bound of each line: `factor × baseline + overhead`. They were set from the
 * `[budget]` lines of CI runs on Linux, Windows and macOS (#83), and are the same on every system.
 */
/** Opening, over a plain read and `JSON.parse` of every file with 16 reads in flight. */
const OPEN_FACTOR = 15;
const OPEN_OVERHEAD_MS = 500;
/**
 * A refresh, over the same plain read and `JSON.parse`. It bounds a refresh because it has the
 * same mix of system calls and JavaScript work, so it slows with the runner the way a refresh
 * does (including the rebuild of the index after a change), and a stat scan does not.
 */
const REFRESH_FACTOR = 2;
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

/** On only during the run of a line that is never checked: the timing itself costs time. */
let instrumented = false;

/** `openLibrary`'s file-system options, timing each call while `instrumented`. */
const timedOptions: OpenOptions = {
  readdir: (async (...args: unknown[]) =>
    instrumented
      ? // biome-ignore lint/suspicious/noExplicitAny: forwards the real call
        phases.listing.time(() => (readdir as any)(...args))
      : // biome-ignore lint/suspicious/noExplicitAny: forwards the real call
        (readdir as any)(...args)) as typeof readdir,
  stat: ((path, options) =>
    instrumented
      ? phases.stat.time(() => stat(path, options))
      : stat(path, options)) satisfies StatFn,
  readFile: (path, file) =>
    instrumented
      ? phases.reads.time(() => readLibraryFileBytes(path, file))
      : readLibraryFileBytes(path, file),
};

function describePhases(): string {
  return `${phases.listing.describe("listing")}; ${phases.stat.describe("stat")}; ${phases.reads.describe("reads")}`;
}

/** Runs `fn` once and returns how long it took, in milliseconds. */
async function timed<T>(fn: () => Promise<T>): Promise<TimedRun<T>> {
  const start = performance.now();
  const value = await fn();
  return { ms: performance.now() - start, value };
}

/** The extra run of a line, which is never checked: timed with the phases of its calls. */
interface Diagnostic {
  ms: number;
  phases: string;
}

/** Runs `fn` once with the instrumentation on, and keeps the time and the phases it spent. */
async function diagnose<T>(fn: () => Promise<T>): Promise<{ result: T; diagnostic: Diagnostic }> {
  for (const phase of Object.values(phases)) phase.reset();
  instrumented = true;
  try {
    const { ms, value } = await timed(fn);
    return { result: value, diagnostic: { ms, phases: describePhases() } };
  } finally {
    instrumented = false;
  }
}

const paths = (): string[] => generated.files.map((file) => join(root, ...file.split("/")));

/**
 * Runs `fn` over `items` with `IN_FLIGHT` workers, keeping no result so that parsed values do not
 * stay alive into the next run. Written here on purpose: the baselines must not share code with
 * the production scan, or a slowdown there would move both sides.
 */
async function pool<T>(items: readonly T[], fn: (item: T) => Promise<unknown>): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) await fn(items[next++] as T);
  };
  await Promise.all(Array.from({ length: IN_FLIGHT }, worker));
}

/** `fs.promises.stat` of every file, 16 in flight. */
const statScan = () => timed(() => pool(paths(), (path) => stat(path)));

/** `readFile` and `JSON.parse` of every file, 16 reads in flight. */
const readParse = () =>
  timed(() => pool(paths(), async (path) => JSON.parse(await readFile(path, "utf8"))));

/** One write of a reference's bytes to a temporary file, `fsync`, rename. */
async function durableWrite(attempt: number): Promise<TimedRun<unknown>> {
  const bytes = await readFile(join(root, "references", `${generated.references[2]}.json`));
  // A target of its own in each run: a rename onto a file just written and closed can fail on
  // Windows while a scanner holds it, and the baseline has no retry like the production write.
  return timed(async () => {
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

/** The three times of some runs, with the fastest, the one that is checked, marked. */
function describeRuns(runs: Fastest<unknown>): string {
  const times = runs.runs.map((run, i) => `${Math.round(run.ms)}${i === runs.index ? "*" : ""}`);
  return `${times.join(", ")} ms`;
}

/**
 * Whether a line passes: its fastest run is under its absolute budget, or within
 * `factor × baseline + overhead`. The message says all the times (the fastest, the one checked, is
 * marked with `*`), both bounds, every baseline, and the time and phases of the extra run, which
 * is not checked. It is logged on every run, so the factors can be set from a CI run.
 */
function judge(
  line: string,
  checked: Fastest<unknown>,
  budgetMs: number,
  bound: { baselineMs: number; baseline: string; factor: number; overheadMs: number },
  baselines: Record<string, Fastest<unknown>>,
  diagnostic: Diagnostic,
): { pass: boolean; message: string } {
  const ms = checked.fastest.ms;
  const relativeMs = bound.factor * bound.baselineMs + bound.overheadMs;
  const pass = ms < budgetMs || ms <= relativeMs;
  const others = Object.entries(baselines)
    .map(([name, runs]) => `${name} ${describeRuns(runs)}`)
    .join("; ");
  const message =
    `${line} took ${describeRuns(checked)} (the fastest, ${Math.round(ms)} ms, is checked): the ` +
    `budget is ${budgetMs} ms, the relative bound ${Math.round(relativeMs)} ms ` +
    `(${bound.factor} × ${bound.baseline} ${Math.round(bound.baselineMs)} ms + ${bound.overheadMs} ms). ` +
    `Baselines (the fastest is marked *): ${others}. ` +
    `One more run, not checked: ${Math.round(diagnostic.ms)} ms, ${diagnostic.phases}.`;
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

const STAT_SCAN = "plain stat scan";
const READ_PARSE = "plain read and JSON.parse";
const DURABLE_WRITE = "plain durable write";

describe("the performance budget, on 5000 generated references", () => {
  it(
    "opens the library in under 5 seconds, or within its bound over a plain read",
    async () => {
      const open = () => timed(() => openLibrary(root, timedOptions));
      const checked = await interleaved(RUNS, { [READ_PARSE]: readParse }, open);
      for (const run of checked.line.runs) {
        if (!run.value.ok) throw new Error(run.value.message);
      }
      const opened = checked.line.fastest.value;
      if (!opened.ok) throw new Error(opened.message);
      library = opened.library;
      // The extra run: one more open, whose handle is dropped.
      const extra = await diagnose(() => openLibrary(root, timedOptions));
      if (!extra.result.ok) throw new Error(extra.result.message);
      const { pass, message } = judge(
        "opening",
        checked.line,
        OPEN_BUDGET_MS,
        {
          baselineMs: checked.baselines[READ_PARSE].fastest.ms,
          baseline: READ_PARSE,
          factor: OPEN_FACTOR,
          overheadMs: OPEN_OVERHEAD_MS,
        },
        checked.baselines,
        extra.diagnostic,
      );
      expect(pass, message).toBe(true);
    },
    LINE_MS,
  );

  it(
    "refreshes in under 0.5 seconds when nothing changed, or within its bound over a read and parse, returning the same snapshot",
    async () => {
      const before = await snap();
      const checked = await interleaved(
        RUNS,
        { [STAT_SCAN]: statScan, [READ_PARSE]: readParse },
        () => timed(() => snap()),
      );
      const extra = await diagnose(() => snap());
      const { pass, message } = judge(
        "the refresh with nothing changed",
        checked.line,
        REFRESH_BUDGET_MS,
        {
          baselineMs: checked.baselines[READ_PARSE].fastest.ms,
          baseline: READ_PARSE,
          factor: REFRESH_FACTOR,
          overheadMs: REFRESH_OVERHEAD_MS,
        },
        checked.baselines,
        extra.diagnostic,
      );
      expect(pass, message).toBe(true);
      for (const run of checked.line.runs) expect(run.value).toBe(before);
      expect(extra.result).toBe(before);
      expect(before.index.references.size).toBe(5000);
    },
    LINE_MS,
  );

  it(
    "refreshes in under 0.5 seconds after one reference changed, or within its bound over a read and parse, with the index updated",
    async () => {
      const before = await snap();
      const inbox = [...before.index.references.values()].find((r) => r.state === "inbox");
      if (inbox === undefined) throw new Error("no reference in the inbox");
      const path = join(root, "references", `${inbox.id}.json`);
      const value: Json = JSON.parse(await readFile(path, "utf8"));
      // Each run changes the file again, from outside (another process), before its timer starts,
      // then times the refresh. An agent proposes an interpretation of p0; the summary grows by
      // one character per run, so the size of the file, and with it its fingerprint, differs from
      // the one before.
      const changeAndRefresh = async <T>(
        attempt: number,
        run: (refresh: () => Promise<Snapshot>) => Promise<T>,
      ): Promise<T> => {
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
        return run(() => snap());
      };
      // The index has the change of the run, whichever run is the fastest.
      const expectChange = (snapshot: Snapshot, attempt: number): void => {
        expect(snapshot.index.references.get(inbox.id)?.state).toBe("processed");
        const file = snapshot.files.get(`references/${inbox.id}.json`);
        expect((file?.value as Json | undefined)?.interpretations.p0.proposal.summary).toBe(
          `A calm page${".".repeat(attempt + 1)}`,
        );
      };
      const checked = await interleaved(
        RUNS,
        { [STAT_SCAN]: statScan, [READ_PARSE]: readParse },
        (attempt) =>
          changeAndRefresh(attempt, async (refresh) => {
            const run = await timed(refresh);
            expectChange(run.value, attempt);
            return run;
          }),
      );
      const extra = await changeAndRefresh(RUNS, async (refresh) => {
        const run = await diagnose(refresh);
        expectChange(run.result, RUNS);
        return run;
      });
      const { pass, message } = judge(
        "the refresh after one change",
        checked.line,
        REFRESH_BUDGET_MS,
        {
          baselineMs: checked.baselines[READ_PARSE].fastest.ms,
          baseline: READ_PARSE,
          factor: REFRESH_FACTOR,
          overheadMs: REFRESH_OVERHEAD_MS,
        },
        checked.baselines,
        extra.diagnostic,
      );
      expect(pass, message).toBe(true);
    },
    LINE_MS,
  );

  it(
    "writes one reference in under 1 second, gate and fsync included, or within its bound over a stat scan and a plain write",
    async () => {
      const id = generated.references[1] as string;
      // Each run edits the reference again, so each one is a real write. A write refreshes the
      // library first, and the write of the run before left a file not yet settled in the cache,
      // so that refresh would recompute the whole index: only the first run would measure "nothing
      // changed, gate, write". So the library is settled, untimed, before each run, and each run
      // checks that the write it timed started from that settled snapshot.
      let settled: Snapshot | undefined;
      const startedFrom: boolean[] = [];
      const settle = async (): Promise<void> => {
        settled = await snap();
      };
      const write = () =>
        library.write((snapshot) => {
          startedFrom.push(snapshot === settled);
          const file = snapshot.files.get(`references/${id}.json`);
          const next = structuredClone(file?.value) as Json;
          next.note = `${next.note} Edited.`;
          return { changes: [{ path: `references/${id}.json`, next }], skipped: [] };
        });
      const checked = await interleaved(
        RUNS,
        { [STAT_SCAN]: statScan, [DURABLE_WRITE]: durableWrite },
        async () => {
          await settle();
          return timed(write);
        },
      );
      await settle();
      const extra = await diagnose(write);
      expect(startedFrom, "every write starts from the settled snapshot").toEqual(
        Array(RUNS + 1).fill(true),
      );
      for (const run of checked.line.runs) expect(run.value.status).toBe("written");
      expect(extra.result.status).toBe("written");
      const { pass, message } = judge(
        "the write",
        checked.line,
        WRITE_BUDGET_MS,
        {
          baselineMs:
            checked.baselines[STAT_SCAN].fastest.ms + checked.baselines[DURABLE_WRITE].fastest.ms,
          baseline: "(plain stat scan + plain durable write)",
          factor: WRITE_FACTOR,
          overheadMs: WRITE_OVERHEAD_MS,
        },
        checked.baselines,
        extra.diagnostic,
      );
      expect(pass, message).toBe(true);
    },
    LINE_MS,
  );
});
