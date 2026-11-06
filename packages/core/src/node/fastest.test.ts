import { describe, expect, it } from "vitest";
import { fastestOf, type TimedRun } from "../../test/support/fastest.js";

/** A `run` that reports the given times, in order, with the position of the run as its value. */
function reporting(times: number[]): (attempt: number) => Promise<TimedRun<number>> {
  return async (attempt) => ({ ms: times[attempt] as number, value: attempt });
}

describe("fastestOf (the helper of the performance budget test)", () => {
  // The fastest run in each position: a helper that returns the first or the slowest run fails
  // at least one of these.
  it.each([
    { times: [10, 30, 20], index: 0 },
    { times: [30, 10, 20], index: 1 },
    { times: [30, 20, 10], index: 2 },
  ])("returns the fastest of $times", async ({ times, index }) => {
    const result = await fastestOf(3, reporting(times));
    expect(result.fastest.ms).toBe(10);
    expect(result.fastest.value).toBe(index);
    expect(result.index).toBe(index);
  });

  it("keeps every run, in the order they ran", async () => {
    const result = await fastestOf(3, reporting([30, 10, 20]));
    expect(result.runs.map((run) => run.ms)).toEqual([30, 10, 20]);
  });

  it("keeps the earliest run when two tie for the fastest", async () => {
    const result = await fastestOf(3, reporting([20, 10, 10]));
    expect(result.index).toBe(1);
  });

  it("runs the given number of times, one after the other", async () => {
    let inFlight = 0;
    let overlapped = false;
    const attempts: number[] = [];
    await fastestOf(4, async (attempt) => {
      attempts.push(attempt);
      inFlight++;
      if (inFlight > 1) overlapped = true;
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight--;
      return { ms: 1, value: attempt };
    });
    expect(attempts).toEqual([0, 1, 2, 3]);
    expect(overlapped).toBe(false);
  });

  it("with one run returns that run", async () => {
    const result = await fastestOf(1, reporting([7]));
    expect(result.fastest.ms).toBe(7);
    expect(result.runs).toHaveLength(1);
  });

  it("refuses a number of runs below 1", async () => {
    await expect(fastestOf(0, reporting([]))).rejects.toThrow(RangeError);
  });
});
