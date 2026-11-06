/**
 * Pause points (docs/design.md section 15, "Core test approach", "Concurrency"). The `at` hook of
 * the file-system modules may return a promise, so a test pauses one run at a named point, lets
 * another run reach a point or its end, then resumes the first. Test-only: it lives outside `src/`.
 */

export interface Pause {
  /** The `at` hook to pass to the run: it pauses at the first call with the point, and only there. */
  at: (point: string) => Promise<void> | undefined;
  /** Settles once the run has reached the point and is waiting there. */
  reached: Promise<void>;
  /** Lets the paused run go on (before it reached the point, it then goes through without waiting). */
  release: () => void;
}

/** A pause at the first call of `at` with `point`. */
export function pauseAt(point: string): Pause {
  let arrive = (): void => undefined;
  let release = (): void => undefined;
  const reached = new Promise<void>((resolve) => {
    arrive = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let paused = false;
  return {
    at: (at) => {
      if (at !== point || paused) return undefined;
      paused = true;
      arrive();
      return released;
    },
    reached,
    release,
  };
}
