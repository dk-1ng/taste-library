import { z } from "zod";
import { addRuleIssue, crossCheck, isAfter, listOf, objectOf, stringOf } from "./shared.js";

/**
 * Helpers shared by the files that hold lists of entries with ids, plain links and timestamps
 * (families, glossary, guardrails, taste profile, projects; format-spec §8–§12). Pure.
 */

/** A list of 0–`max` items in which no item repeats an earlier one (compared by `keyOf`). */
export function uniqueList<T extends z.ZodType>(
  item: T,
  max: number,
  keyOf: (item: unknown) => string | undefined = (value) => stringOf(value),
  /** Where inside an item the repeated value sits, for the pointer (a member's `target`). */
  inside: string[] = [],
) {
  return z
    .array(item)
    .max(max)
    .check(
      crossCheck((raw, ctx) => {
        const seen = new Map<string, number>();
        listOf(raw).forEach((value, index) => {
          const key = keyOf(value);
          if (key === undefined) return; // malformed: reported by its own rule
          const first = seen.get(key);
          if (first === undefined) seen.set(key, index);
          else addRuleIssue(ctx, [index, ...inside], `must not repeat item ${first}.`);
        });
      }),
    );
}

/** `updatedAt` is never earlier than `createdAt` (format-spec §4.1). */
export function checkUpdatedAfterCreated(value: unknown, ctx: z.RefinementCtx): void {
  const object = objectOf(value);
  if (isAfter(stringOf(object.createdAt) ?? "", stringOf(object.updatedAt) ?? "")) {
    addRuleIssue(ctx, ["updatedAt"], "must not be earlier than createdAt.");
  }
}

/** The ids of the entries of `list` must be unique: the second use is a `duplicate-id`. */
export function checkUniqueIds(
  list: unknown,
  field: string,
  isId: (id: string) => boolean,
  ctx: z.RefinementCtx,
): void {
  const seen = new Set<string>();
  listOf(list).forEach((raw, index) => {
    const id = stringOf(objectOf(raw).id);
    if (id === undefined || !isId(id)) return;
    if (seen.has(id)) {
      addRuleIssue(
        ctx,
        [field, index, "id"],
        `${JSON.stringify(id)} is used by more than one entry.`,
        "duplicate-id",
      );
    }
    seen.add(id);
  });
}
