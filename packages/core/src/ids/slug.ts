import { WINDOWS_RESERVED } from "../schemas/v1/shared.js";
import { type RandomSource, randomPart } from "./random.js";

/**
 * Slugs (format-spec §4.3): derived once from a name when the thing is created, never changed.
 */

export const MAX_SLUG_LENGTH = 64;

export type SlugKind = "family" | "project";

/** Step 1: NFKD, drop combining marks, lowercase, runs of other characters to `-`, trim. */
export function deriveSlug(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Step 2: at most `max` characters, cut at the last `-` within the limit, or exactly at it. */
export function shortenSlug(slug: string, max: number = MAX_SLUG_LENGTH): string {
  if (slug.length <= max) return slug;
  const hyphen = slug.lastIndexOf("-", max);
  const cut = hyphen > 0 ? slug.slice(0, hyphen) : slug.slice(0, max);
  return cut.replace(/-+$/, "");
}

export interface SlugOptions {
  /** Says whether a slug is already used by another family or project. */
  isTaken?: (slug: string) => boolean;
  random?: RandomSource;
}

/** The slug for a new family or project called `name` (steps 1 to 4). */
export function makeSlug(name: string, kind: SlugKind, options: SlugOptions = {}): string {
  const isTaken = options.isTaken ?? (() => false);
  const base = shortenSlug(deriveSlug(name));
  if (base === "" || WINDOWS_RESERVED.has(base)) {
    for (let attempt = 0; attempt < 1000; attempt++) {
      const slug = `${kind}-${randomPart(6, options.random)}`;
      if (!isTaken(slug)) return slug;
    }
    throw new Error("Could not draw a free slug: every attempt was already taken.");
  }
  if (!isTaken(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const slug = `${shortenSlug(base, MAX_SLUG_LENGTH - suffix.length)}${suffix}`;
    if (!isTaken(slug)) return slug;
  }
}
