import { describe, expect, it } from "vitest";
import { interleaved, pickFastest, type TimedRun } from "../../test/support/fastest.js";

/** A `run` that reports the given times, in order, with the position of the run as its value. */
function reporting(times: number[]): (attempt: number) => Promise<TimedRun<number>> {
  return async (attempt) => ({ ms: times[attempt] as number, value: attempt });
}

const runsOf = (times: number[]): TimedRun<number>[] => times.map((ms, value) => ({ ms, value }));

describe("pickFastest (the selection of the performance budget test)", () => {
  // The fastest run in each position: a helper that returns the first or the slowest run fails
  // at least one of these.
  it.each([
    { times: [10, 30, 20], index: 0 },
    { times: [30, 10, 20], index: 1 },
    { times: [30, 20, 10], index: 2 },
  ])("returns the fastest of $times", ({ times, index }) => {
    const result = pickFastest(runsOf(times));
    expect(result.fastest.ms).toBe(10);
    expect(result.fastest.value).toBe(index);
    expect(result.index).toBe(index);
  });

  it("keeps every run, in the order they ran", () => {
    expect(pickFastest(runsOf([30, 10, 20])).runs.map((run) => run.ms)).toEqual([30, 10, 20]);
  });

  it("keeps the earliest run when two tie for the fastest", () => {
    expect(pickFastest(runsOf([20, 10, 10])).index).toBe(1);
  });

  it("with one run returns that run", () => {
    const result = pickFastest(runsOf([7]));
    expect(result.fastest.ms).toBe(7);
    expect(result.runs).toHaveLength(1);
  });

  it("refuses no runs", () => {
    expect(() => pickFastest([])).toThrow(RangeError);
  });
});

describe("interleaved (the helper of the performance budget test)", () => {
  it("times, in each attempt, every baseline in the order given, then the line", async () => {
    const calls: string[] = [];
    const call = (name: string) => async (attempt: number) => {
      calls.push(`${name}${attempt}`);
      return { ms: 1, value: name };
    };
    await interleaved(3, { a: call("a"), b: call("b") }, call("line"));
    expect(calls).toEqual(["a0", "b0", "line0", "a1", "b1", "line1", "a2", "b2", "line2"]);
  });

  it("gives each call its attempt number", async () => {
    const seen: number[] = [];
    const record = async (attempt: number) => {
      seen.push(attempt);
      return { ms: 1, value: attempt };
    };
    await interleaved(3, { a: record }, record);
    expect(seen).toEqual([0, 0, 1, 1, 2, 2]);
  });

  it("picks the fastest baseline and the fastest line independently", async () => {
    const result = await interleaved(3, { a: reporting([10, 30, 20]) }, reporting([30, 20, 10]));
    expect(result.baselines.a.index).toBe(0);
    expect(result.baselines.a.fastest.ms).toBe(10);
    expect(result.line.index).toBe(2);
    expect(result.line.fastest.ms).toBe(10);
  });

  it("keeps every run, in order, and the earliest run wins a tie", async () => {
    const result = await interleaved(3, { a: reporting([20, 10, 10]) }, reporting([5, 5, 9]));
    expect(result.baselines.a.runs.map((run) => run.ms)).toEqual([20, 10, 10]);
    expect(result.baselines.a.index).toBe(1);
    expect(result.line.runs.map((run) => run.ms)).toEqual([5, 5, 9]);
    expect(result.line.index).toBe(0);
  });

  it("never has two calls in flight at once", async () => {
    let inFlight = 0;
    let overlapped = false;
    const slow = async (attempt: number) => {
      inFlight++;
      if (inFlight > 1) overlapped = true;
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight--;
      return { ms: 1, value: attempt };
    };
    await interleaved(3, { a: slow, b: slow }, slow);
    expect(overlapped).toBe(false);
  });

  it.each([0, -1, 1.5])("refuses %s runs", async (times) => {
    await expect(interleaved(times, {}, reporting([]))).rejects.toThrow(RangeError);
  });
});
