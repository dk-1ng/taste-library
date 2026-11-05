import type { BigIntStats } from "node:fs";
import { describe, expect, it } from "vitest";
import { fingerprintOf, isUnsettled, UNSETTLED_NS } from "./fingerprint.js";

/** The four fields a fingerprint reads, as `stat({ bigint: true })` gives them. */
function stats(fields: { size?: bigint; mtimeNs?: bigint; ctimeNs?: bigint; ino?: bigint }) {
  return {
    size: 120n,
    mtimeNs: 1_800_000_000_000_000_000n,
    ctimeNs: 1_800_000_000_500_000_000n,
    ino: 42n,
    ...fields,
  } as unknown as BigIntStats;
}

describe("fingerprintOf (docs/design.md section 4, Index, Freshness)", () => {
  it("is (size, mtime, ctime, inode)", () => {
    expect(fingerprintOf(stats({}))).toBe("120:1800000000000000000:1800000000500000000:42");
  });

  it("changes with each of the four", () => {
    const base = fingerprintOf(stats({}));
    for (const change of [{ size: 121n }, { mtimeNs: 1n }, { ctimeNs: 1n }, { ino: 43n }]) {
      expect(fingerprintOf(stats(change)), JSON.stringify(Object.keys(change))).not.toBe(base);
    }
  });
});

describe("isUnsettled", () => {
  const mtimeMs = 1_800_000_000_000;
  const at = (ms: number) => isUnsettled(stats({ mtimeNs: BigInt(mtimeMs) * 1_000_000n }), ms);

  it("is 3 seconds", () => {
    expect(UNSETTLED_NS).toBe(3_000_000_000n);
  });

  it("holds from the mtime itself up to 3 seconds after it", () => {
    expect(at(mtimeMs)).toBe(true);
    expect(at(mtimeMs + 2_999)).toBe(true);
    expect(at(mtimeMs + 3_000)).toBe(false);
    expect(at(mtimeMs + 3_600_000)).toBe(false);
  });

  it("does not hold for an mtime in the future", () => {
    expect(at(mtimeMs - 1)).toBe(false);
    expect(at(mtimeMs - 3_600_000)).toBe(false);
  });

  it("compares nanoseconds: an mtime just under a millisecond after the clock is in the future", () => {
    const s = stats({ mtimeNs: BigInt(mtimeMs) * 1_000_000n + 999_999n });
    expect(isUnsettled(s, mtimeMs)).toBe(false);
    expect(isUnsettled(s, mtimeMs + 1)).toBe(true);
  });
});
