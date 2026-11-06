/** One timed run: how long it took, in milliseconds, and what it produced. */
export interface TimedRun<T> {
  ms: number;
  value: T;
}

/** The fastest of some runs: the run that is checked, and every run, in the order they ran. */
export interface Fastest<T> {
  /** The fastest run (the earliest one when two tie). */
  fastest: TimedRun<T>;
  /** The position of `fastest` in `runs`, from 0. */
  index: number;
  runs: TimedRun<T>[];
}

/** Picks the fastest run (the earliest when two tie) and keeps all of them. */
export function pickFastest<T>(runs: TimedRun<T>[]): Fastest<T> {
  if (runs.length < 1) throw new RangeError("runs must have 1 or more runs");
  let index = 0;
  for (let i = 1; i < runs.length; i++) {
    if ((runs[i] as TimedRun<T>).ms < (runs[index] as TimedRun<T>).ms) index = i;
  }
  return { fastest: runs[index] as TimedRun<T>, index, runs };
}

/** The result of `interleaved`: the fastest of the line and of each baseline. */
export interface Interleaved<T, K extends string> {
  line: Fastest<T>;
  baselines: Record<K, Fastest<unknown>>;
}

/**
 * Times a line and its baselines `times` times, one call at a time, and in each attempt the
 * baselines first (in the order given) and then the line, so a baseline is timed right before the
 * run it bounds and a slowdown of the runner that lasts a few seconds moves both. Returns the
 * fastest run of the line and of each baseline, chosen independently, with all their runs. Noise on
 * a shared CI runner only adds time, so the fastest run is the fair measure of the code, while a
 * real regression shows in every run (docs/design.md section 4, "Index", "Performance budget").
 * Each callback gets the attempt number, from 0, and does its own timing, so setup that must not
 * be timed comes before its timer starts.
 */
export async function interleaved<T, K extends string>(
  times: number,
  baselines: Record<K, (attempt: number) => Promise<TimedRun<unknown>>>,
  line: (attempt: number) => Promise<TimedRun<T>>,
): Promise<Interleaved<T, K>> {
  if (!Number.isInteger(times) || times < 1) throw new RangeError("times must be 1 or more");
  const names = Object.keys(baselines) as K[];
  const baselineRuns = Object.fromEntries(
    names.map((name) => [name, [] as TimedRun<unknown>[]]),
  ) as unknown as Record<K, TimedRun<unknown>[]>;
  const lineRuns: TimedRun<T>[] = [];
  for (let attempt = 0; attempt < times; attempt++) {
    for (const name of names) baselineRuns[name].push(await baselines[name](attempt));
    lineRuns.push(await line(attempt));
  }
  return {
    line: pickFastest(lineRuns),
    baselines: Object.fromEntries(
      names.map((name) => [name, pickFastest(baselineRuns[name])]),
    ) as Record<K, Fastest<unknown>>,
  };
}
