import { describe, expect, it } from "vitest";
import { type DerivedState, derivedState, type ReferenceForState } from "./derived-state.js";

const T = "2026-11-02T09:00:00.000Z";
const SHA = "0".repeat(64);

type Kind = "user" | "to-review" | "accepted" | "corrected" | "rejected";

function interpretation(kind: Kind) {
  if (kind === "user") return { origin: "user" as const, content: {}, writtenAt: T };
  return {
    origin: "agent" as const,
    proposedBy: "claude-code",
    proposedAt: T,
    inputSha256: SHA,
    proposal: {},
    status: kind,
    correction: kind === "corrected" ? {} : null,
    reviewedAt: kind === "to-review" ? null : T,
  };
}

/** A reference with `pins` pins (`p1`, `p2`, …) and the interpretations given by piece. */
function reference(pins: number, interpreted: Record<string, Kind>): ReferenceForState {
  return {
    pins: Array.from({ length: pins }, (_, index) => ({ id: `p${index + 1}`, note: "" })),
    interpretations: Object.fromEntries(
      Object.entries(interpreted).map(([piece, kind]) => [piece, interpretation(kind)]),
    ),
  };
}

describe("derivedState (format-spec §7.7, §13.3)", () => {
  const cases: [string, ReferenceForState, DerivedState][] = [
    ["no pins and no interpretation", reference(0, {}), "inbox"],
    ["pins but no interpretation", reference(2, {}), "inbox"],
    ["p0 to review, no pins", reference(0, { p0: "to-review" }), "processed"],
    ["p0 accepted, no pins", reference(0, { p0: "accepted" }), "reviewed"],
    ["p0 corrected, no pins", reference(0, { p0: "corrected" }), "reviewed"],
    ["p0 written by the user, no pins", reference(0, { p0: "user" }), "reviewed"],
    ["p0 rejected, no pins: a rejection is a review", reference(0, { p0: "rejected" }), "reviewed"],
    [
      "every piece rejected",
      reference(2, { p0: "rejected", p1: "rejected", p2: "rejected" }),
      "reviewed",
    ],
    ["p0 corrected and p1 rejected", reference(1, { p0: "corrected", p1: "rejected" }), "reviewed"],
    ["two pins, only p0 accepted", reference(2, { p0: "accepted" }), "processed"],
    ["only the pins interpreted", reference(2, { p1: "user", p2: "accepted" }), "processed"],
    [
      "every piece interpreted, one to review",
      reference(2, { p0: "accepted", p1: "to-review", p2: "user" }),
      "processed",
    ],
  ];

  for (const [name, value, state] of cases) {
    it(`${name}: ${state}`, () => {
      expect(derivedState(value)).toBe(state);
    });
  }

  it("does not change when an accepted proposal is stale (the note changed)", () => {
    // The proposal was made over another note: its inputSha256 no longer matches.
    const stale: ReferenceForState & { note: string } = {
      ...reference(0, { p0: "accepted" }),
      note: "the user rewrote the note",
    };
    expect(derivedState(stale)).toBe("reviewed");
  });
});
