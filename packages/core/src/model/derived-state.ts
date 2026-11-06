/**
 * The derived state of a reference (format-spec §7.7): not stored, derived from its
 * interpretations. Pure. A rejected interpretation counts as reviewed (format-spec §13.3, the row
 * "piece interpretation"). Staleness (`proposal-stale`, §13.4) does not change the state.
 */

export type DerivedState = "inbox" | "processed" | "reviewed";

/** The parts of a reference that decide its state. */
export interface ReferenceForState {
  pins: readonly { id: string }[];
  interpretations: Readonly<
    Record<string, { origin: "user" } | { origin: "agent"; status: string }>
  >;
}

export function derivedState(reference: ReferenceForState): DerivedState {
  const pieces = ["p0", ...reference.pins.map((pin) => pin.id)];
  const interpreted = pieces.filter((piece) => Object.hasOwn(reference.interpretations, piece));
  if (interpreted.length === 0) return "inbox";
  const toReview = interpreted.some((piece) => {
    const value = reference.interpretations[piece];
    return value?.origin === "agent" && value.status === "to-review";
  });
  return interpreted.length === pieces.length && !toReview ? "reviewed" : "processed";
}
