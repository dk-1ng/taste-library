/**
 * Simulated crashes (docs/design.md section 15, "Core test approach", "Crash points"). A crash is
 * thrown from the `at` hook: it carries no errno code, so no result path catches it and nothing is
 * cleaned up, as when a process dies at that point.
 */

export class SimulatedCrash extends Error {
  constructor(point = "a crash point") {
    super(`Simulated crash at ${point}.`);
    this.name = "SimulatedCrash";
  }
}

/** An `at` hook that records every point it is called with, in order. */
export function recordPoints(): { points: string[]; at: (point: string) => void } {
  const points: string[] = [];
  return { points, at: (point) => void points.push(point) };
}

/** An `at` hook that crashes on its `call`-th call (1-based) and records the points before it. */
export function crashAtCall(call: number): { points: string[]; at: (point: string) => void } {
  const points: string[] = [];
  return {
    points,
    at: (point) => {
      points.push(point);
      if (points.length === call) throw new SimulatedCrash(point);
    },
  };
}

/** An `at` hook that crashes at the first call with `point`. */
export function crashAt(point: string): (at: string) => void {
  return (at) => {
    if (at === point) throw new SimulatedCrash(point);
  };
}
