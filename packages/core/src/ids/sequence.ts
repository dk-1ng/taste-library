/**
 * Sequential identifiers `m<n>`, `p<n>`, `d<n>` (format-spec §4.3): the next number is
 * `lastIssued + 1`, and the counter never goes down, so a deleted number is never issued again.
 */

export type SequencePrefix = "m" | "p" | "d";

export interface Issued {
  id: string;
  /** The value to store as the new `lastIssued`. */
  lastIssued: number;
}

/** Issues the next id after `lastIssued` (the highest number ever issued, 0 when none). */
export function issueNext(prefix: SequencePrefix, lastIssued: number): Issued {
  if (!Number.isSafeInteger(lastIssued) || lastIssued < 0) {
    throw new Error(`lastIssued must be a non-negative safe integer, got ${lastIssued}.`);
  }
  const next = lastIssued + 1;
  if (!Number.isSafeInteger(next)) throw new Error("No sequential number is left to issue.");
  return { id: `${prefix}${next}`, lastIssued: next };
}
