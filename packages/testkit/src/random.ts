export interface SeededRandom {
  /** Next float in [0, 1). */
  next(): number;
  /** Next integer in [0, max). */
  int(max: number): number;
}

/** mulberry32: a tiny deterministic PRNG, identical on every platform. */
export function createSeededRandom(seed: number): SeededRandom {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { next, int: (max) => Math.floor(next() * max) };
}
