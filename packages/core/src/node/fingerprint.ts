import type { BigIntStats } from "node:fs";

/**
 * File fingerprints and the unsettled window (docs/design.md section 4, "Index", "Freshness").
 * A refresh trusts a file whose fingerprint did not change, unless the file is unsettled: then a
 * second change within the file system's timestamp resolution could have kept size and `mtime`, so
 * it is read again and its bytes compared.
 */

/** `(size, mtime, ctime, inode)`, from `stat` with `bigint: true` (nanoseconds where the file system has them). */
export function fingerprintOf(stats: BigIntStats): string {
  return `${stats.size}:${stats.mtimeNs}:${stats.ctimeNs}:${stats.ino}`;
}

/** How long after its `mtime` a file stays unsettled: 3 seconds (FAT keeps 2-second times). */
export const UNSETTLED_NS = 3_000_000_000n;

/**
 * Whether the file is unsettled: `0 ≤ statTime − mtime < 3 s`, `statTimeMs` being the system
 * clock when it was stat'd. An `mtime` in the future (a sync tool that keeps another computer's
 * times) does not count.
 */
export function isUnsettled(stats: BigIntStats, statTimeMs: number): boolean {
  const age = BigInt(Math.trunc(statTimeMs)) * 1_000_000n - stats.mtimeNs;
  return age >= 0n && age < UNSETTLED_NS;
}
