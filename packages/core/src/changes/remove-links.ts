import type { LibraryFileKind } from "../format.js";
import type { FileValue } from "../json/canonical.js";

/**
 * Link removal for deletions (format-spec §14): each function returns a new value of one file
 * without the links to the deleted thing, or `null` when the file holds none. Pure and
 * non-mutating. Links sit next to `Authored` values, never inside them (format-spec §4.6), so no
 * `Authored` value is edited; `updatedAt` and `lastIssued` are left as they are, and the write
 * pipeline moves the `updatedAt` of each file or entry that changed.
 */

/** Whether a `PieceRef` points to the deleted piece, or to any piece of the deleted reference. */
export type PieceMatcher = (ref: string) => boolean;

/** Matches the piece `<refId>#<pinId>`, or every piece of `refId` when `pinId` is not given. */
export function pieceMatcher(refId: string, pinId?: string): PieceMatcher {
  if (pinId !== undefined) {
    const exact = `${refId}#${pinId}`;
    return (ref) => ref === exact;
  }
  const prefix = `${refId}#`;
  return (ref) => ref.startsWith(prefix);
}

/** `list` without the matching links, or `null` when none matched. */
function kept(list: readonly string[], matches: PieceMatcher): string[] | null {
  const rest = list.filter((ref) => !matches(ref));
  return rest.length === list.length ? null : rest;
}

/**
 * Applies `edit` to each entry of `entries`; the new list, or `null` when no entry changed. An
 * entry that `edit` leaves alone (returns `null` for) is kept as it is.
 */
function editEntries<T>(entries: readonly T[], edit: (entry: T) => T | null): T[] | null {
  let changed = false;
  const next = entries.map((entry) => {
    const edited = edit(entry);
    if (edited === null) return entry;
    changed = true;
    return edited;
  });
  return changed ? next : null;
}

/**
 * The value of a file of type `kind` without its `PieceRef` links that `matches` accepts: family
 * members, glossary term pieces, guardrail sources, statement evidence and direction pieces.
 * `null` when the file holds none (including a file type that holds no `PieceRef`).
 */
export function withoutPieceLinks(
  kind: LibraryFileKind,
  value: unknown,
  matches: PieceMatcher,
): unknown {
  switch (kind) {
    case "family": {
      const family = value as FileValue<"family">;
      const members = family.members.filter((member) => !matches(member.target));
      return members.length === family.members.length ? null : { ...family, members };
    }
    case "glossary": {
      const glossary = value as FileValue<"glossary">;
      const terms = editEntries(glossary.terms, (term) => {
        const pieces = kept(term.pieces, matches);
        return pieces === null ? null : { ...term, pieces };
      });
      return terms === null ? null : { ...glossary, terms };
    }
    case "guardrails": {
      const file = value as FileValue<"guardrails">;
      const guardrails = editEntries(file.guardrails, (guardrail) => {
        const sources = kept(guardrail.sources, matches);
        return sources === null ? null : { ...guardrail, sources };
      });
      return guardrails === null ? null : { ...file, guardrails };
    }
    case "taste-profile": {
      const profile = value as FileValue<"taste-profile">;
      const statements = editEntries(profile.statements, (statement) => {
        const evidence = kept(statement.evidence, matches);
        return evidence === null ? null : { ...statement, evidence };
      });
      return statements === null ? null : { ...profile, statements };
    }
    case "directions": {
      const file = value as FileValue<"directions">;
      const directions = editEntries(file.directions, (direction) => {
        const pieces = kept(direction.pieces, matches);
        return pieces === null ? null : { ...direction, pieces };
      });
      return directions === null ? null : { ...file, directions };
    }
    default:
      return null;
  }
}

/** The directions without their link to the family `slug` (`family` becomes `null`), or `null`. */
export function withoutFamilyLink(
  value: FileValue<"directions">,
  slug: string,
): FileValue<"directions"> | null {
  const directions = editEntries(value.directions, (direction) =>
    direction.family === slug ? { ...direction, family: null } : null,
  );
  return directions === null ? null : { ...value, directions };
}

/** The directions without their links to the guardrail `id`, or `null`. */
export function withoutGuardrailLink(
  value: FileValue<"directions">,
  id: string,
): FileValue<"directions"> | null {
  const directions = editEntries(value.directions, (direction) => {
    const guardrails = kept(direction.guardrails, (linked) => linked === id);
    return guardrails === null ? null : { ...direction, guardrails };
  });
  return directions === null ? null : { ...value, directions };
}

/**
 * The reference without its link to the direction `direction` of the project `project` (its
 * `result.direction` becomes `null`; the link to the project stays), or `null`.
 */
export function withoutDirectionLink(
  value: FileValue<"reference">,
  project: string,
  direction: string,
): FileValue<"reference"> | null {
  const result = value.result;
  if (result === null || result.project !== project || result.direction !== direction) return null;
  return { ...value, result: { ...result, direction: null } };
}
