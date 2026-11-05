/**
 * The effective value of an `Authored` value and the weight of a `ReviewedLink` (format-spec
 * §13.3): what consumers use. Pure. The values passed in have passed validation, so their
 * invariants hold (a `corrected` value has a `correction`).
 */

/** The parts of an `Authored<T>` (format-spec §4.6) that decide its effective value. */
export type AuthoredValue<T> =
  | { origin: "user"; content: T }
  | {
      origin: "agent";
      proposal: T;
      status: "to-review" | "accepted" | "corrected" | "rejected";
      correction: T | null;
    };

/** The parts of a `ReviewedLink<K>` (format-spec §4.7) that decide whether it counts. */
export type ReviewedLinkValue =
  | { origin: "user" }
  | { origin: "agent"; status: "to-review" | "accepted" | "rejected" };

/** The effective value, `tentative` when it is a proposal still to review; `null` when rejected. */
export type Effective<T> = { value: T; tentative: boolean } | null;

export function effectiveOf<T>(authored: AuthoredValue<T>): Effective<T> {
  if (authored.origin === "user") return { value: authored.content, tentative: false };
  switch (authored.status) {
    case "accepted":
      return { value: authored.proposal, tentative: false };
    case "corrected":
      return { value: authored.correction as T, tentative: false };
    case "to-review":
      return { value: authored.proposal, tentative: true };
    case "rejected":
      return null;
  }
}

/** `counts`: a user link or an accepted one; `tentative`: to review; `none`: rejected. */
export type LinkWeight = "counts" | "tentative" | "none";

export function linkWeight(link: ReviewedLinkValue): LinkWeight {
  if (link.origin === "user") return "counts";
  switch (link.status) {
    case "accepted":
      return "counts";
    case "to-review":
      return "tentative";
    case "rejected":
      return "none";
  }
}
