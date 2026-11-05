/**
 * Region rounding (docs/design.md section 4, "Proportions"; format-spec §3.3). Pure. Applied only
 * to values that already passed validation: rounding is not a repair.
 */

const MILLIONTHS = 1_000_000;

/**
 * One axis of a region, in integer millionths (design.md section 4, "Proportions"): the size is
 * at least 1e-6, the position at most 1 − 1e-6, and the size is clamped to `1 − position`, so
 * `position + size ≤ 1` holds whatever the rounding does.
 */
export function roundAxis(position: number, size: number): { position: number; size: number } {
  const p = Math.min(Math.round(position * MILLIONTHS), MILLIONTHS - 1);
  let s = Math.max(Math.round(size * MILLIONTHS), 1);
  if (p + s > MILLIONTHS) s = MILLIONTHS - p;
  return { position: p / MILLIONTHS, size: s / MILLIONTHS };
}

/** Rounds a region that passed validation to at most 6 decimals, keeping it valid. */
export function roundRegion(region: { x: number; y: number; w: number; h: number }): {
  x: number;
  y: number;
  w: number;
  h: number;
} {
  const horizontal = roundAxis(region.x, region.w);
  const vertical = roundAxis(region.y, region.h);
  return { x: horizontal.position, y: vertical.position, w: horizontal.size, h: vertical.size };
}
