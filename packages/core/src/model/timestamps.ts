/**
 * The timestamps a write sets (docs/design.md section 4, "Writing library files", layer 6;
 * format-spec §4.1). Pure: canonical values and a time in, a stamped value out.
 *
 * Operations leave the old `updatedAt` in place; this helper decides which files and entries
 * changed and moves exactly those. Timestamps are UTC with milliseconds, so comparing the text
 * compares the time.
 */

type Loose = Record<string, unknown>;

/** The list of entries that carry their own `createdAt` and `updatedAt`, by file type. */
const ENTRY_LISTS: Readonly<Record<string, string>> = {
  glossary: "terms",
  guardrails: "guardrails",
  "taste-profile": "statements",
  directions: "directions",
};

const isRecord = (value: unknown): value is Loose =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The later of two timestamps (a lower bound that keeps `updatedAt` from going back, §4.1). */
export function laterOf(a: string, b: string): string {
  return a >= b ? a : b;
}

/** A copy of `value` without any `updatedAt` key, at any depth. */
function withoutUpdatedAt(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutUpdatedAt);
  if (!isRecord(value)) return value;
  const copy: Loose = {};
  for (const [key, item] of Object.entries(value)) {
    if (key !== "updatedAt") copy[key] = withoutUpdatedAt(item);
  }
  return copy;
}

/** Whether two canonical values differ in anything but their `updatedAt` fields. */
export function differsBesidesUpdatedAt(previous: unknown, next: unknown): boolean {
  return JSON.stringify(withoutUpdatedAt(previous)) !== JSON.stringify(withoutUpdatedAt(next));
}

const entriesOf = (value: Loose, field: string): Loose[] =>
  Array.isArray(value[field]) ? (value[field] as unknown[]).filter(isRecord) : [];

/**
 * Stamps the canonical `next` value of a file of type `type` against its canonical `previous`
 * value (`null` for a new file) at `now`:
 *
 * - a new file, and every new entry or pin (an id the old value does not have), gets `createdAt`
 *   and `updatedAt` equal to `now`;
 * - an entry that differs from the old entry with the same id, once `updatedAt` is set aside,
 *   gets `updatedAt` = the later of `now` and its `createdAt`;
 * - the file, if anything in it differs, gets `updatedAt` = the later of `now` and its `createdAt`.
 *
 * Whether the file differs at all is decided by the caller with `differsBesidesUpdatedAt`; an
 * unchanged file is not stamped.
 */
export function stampFile(type: string, previous: unknown, next: unknown, now: string): unknown {
  if (!isRecord(next)) return next;
  const result: Loose = { ...next };
  const old = isRecord(previous) ? previous : null;

  if (old === null && "createdAt" in result) result.createdAt = now;
  // Only some files carry their own `updatedAt` (references, families, projects); a library has just `createdAt`.
  if ("updatedAt" in result) {
    const created = typeof result.createdAt === "string" ? result.createdAt : now;
    result.updatedAt = laterOf(now, created);
  }

  const list = ENTRY_LISTS[type];
  if (list !== undefined && Array.isArray(result[list])) {
    const before = new Map(entriesOf(old ?? {}, list).map((entry) => [entry.id, entry]));
    result[list] = entriesOf(result, list).map((entry) => {
      const earlier = before.get(entry.id);
      if (earlier === undefined) return { ...entry, createdAt: now, updatedAt: now };
      if (!differsBesidesUpdatedAt(earlier, entry))
        return { ...entry, updatedAt: earlier.updatedAt };
      const created = typeof entry.createdAt === "string" ? entry.createdAt : now;
      return { ...entry, updatedAt: laterOf(now, created) };
    });
  }

  if (type === "reference" && Array.isArray(result.pins)) {
    const known = new Set(entriesOf(old ?? {}, "pins").map((pin) => pin.id));
    result.pins = entriesOf(result, "pins").map((pin) =>
      known.has(pin.id) ? pin : { ...pin, createdAt: now },
    );
  }
  return result;
}
