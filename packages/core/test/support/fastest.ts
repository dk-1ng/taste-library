/** One timed run: how long it took, in milliseconds, and what it produced. */
export interface TimedRun<T> {
  ms: number;
  value: T;
}

/** The result of `fastestOf`: the run that is checked, and every run, in the order they ran. */
export interface Fastest<T> {
  /** The fastest run (the earliest one when two tie). */
  fastest: TimedRun<T>;
  /** The position of `fastest` in `runs`, from 0. */
  index: number;
  runs: TimedRun<T>[];
}

/**
 * Runs `run` `times` times, one after the other, and returns the fastest run along with all of
 * them. Noise on a shared CI runner only adds time, so the fastest run is the fair measure of the
 * code, while a real regression shows in every run (docs/design.md section 4, "Index",
 * "Performance budget"). `run` gets the position of the run, from 0, so a line that changes
 * something between runs can tell them apart.
 */
export async function fastestOf<T>(
  times: number,
  run: (attempt: number) => Promise<TimedRun<T>>,
): Promise<Fastest<T>> {
  if (!Number.isInteger(times) || times < 1) throw new RangeError("times must be 1 or more");
  const runs: TimedRun<T>[] = [];
  for (let attempt = 0; attempt < times; attempt++) runs.push(await run(attempt));
  let index = 0;
  for (let i = 1; i < runs.length; i++) {
    if ((runs[i] as TimedRun<T>).ms < (runs[index] as TimedRun<T>).ms) index = i;
  }
  return { fastest: runs[index] as TimedRun<T>, index, runs };
}
