import type { z } from "zod";
import { DirectionsSchema } from "../schemas/v1/directions.js";
import { FamilySchema } from "../schemas/v1/family.js";
import { GlossarySchema } from "../schemas/v1/glossary.js";
import { GuardrailsSchema } from "../schemas/v1/guardrails.js";
import { LibrarySchema } from "../schemas/v1/library.js";
import { MediaMarkerSchema } from "../schemas/v1/marker.js";
import { ProjectSchema } from "../schemas/v1/project.js";
import { ReferenceSchema } from "../schemas/v1/reference.js";
import { sequenceNumber } from "../schemas/v1/shared.js";
import { TasteProfileSchema } from "../schemas/v1/taste-profile.js";

/**
 * The canonical form of a library file (format-spec §3.3; docs/design.md section 4, "Writing
 * library files": canonicalize, serialize). Pure: values in, text or a verdict out.
 *
 * Every function here takes a value that already passed its schema. Rounding is not a repair, so
 * an invalid value throws (a bug in the caller), it is never silently fixed.
 */

type Loose = Record<string, unknown>;

const MILLIONTHS = 1_000_000;

/** Code-unit order: the same on every computer, unlike `localeCompare`. */
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Sorts a copy of `list` by a text or numeric key. */
function sortedBy<T>(list: readonly T[], key: (item: T) => string | number): T[] {
  return [...list].sort((a, b) => {
    const left = key(a);
    const right = key(b);
    return typeof left === "number" && typeof right === "number"
      ? left - right
      : compareText(String(left), String(right));
  });
}

const byId = (item: { id: string }): string => item.id;
const byIdNumber = (item: { id: string }): number => sequenceNumber(item.id);

/** `ref-…#p2` → the reference id and the piece number, so `#p10` sorts after `#p2`. */
function targetOrder(a: { target: string }, b: { target: string }): number {
  const [refA = "", pieceA = "p0"] = a.target.split("#");
  const [refB = "", pieceB = "p0"] = b.target.split("#");
  return compareText(refA, refB) || sequenceNumber(pieceA) - sequenceNumber(pieceB);
}

/**
 * One axis of a region, in integer millionths (design.md section 4, "Proportions"): the size is
 * at least 1e-6, the position at most 1 − 1e-6, and the size is clamped to `1 − position`, so
 * `position + size ≤ 1` holds whatever the rounding does.
 */
export function roundAxis(position: number, size: number): { position: number; size: number } {
  const p = Math.min(Math.round(position * MILLIONTHS), MILLIONTHS - 1);
  let s = Math.max(Math.round(size * MILLIONTHS), 1);
  if (p + s > MILLIONTHS) s = MILLIONTHS - p;
  return { position: p / MILLIONTHS, size: s / MILLIONTHS };
}

/** Rounds a region that passed validation to at most 6 decimals, keeping it valid. */
export function roundRegion(region: { x: number; y: number; w: number; h: number }): {
  x: number;
  y: number;
  w: number;
  h: number;
} {
  const horizontal = roundAxis(region.x, region.w);
  const vertical = roundAxis(region.y, region.h);
  return { x: horizontal.position, y: vertical.position, w: horizontal.size, h: vertical.size };
}

/** The key order of a frame, which the media schema reads as `unknown` and so cannot order. */
const FRAME_KEYS = ["timeMs", "file", "type", "bytes", "sha256", "width", "height"] as const;

function canonicalReference(value: z.infer<typeof ReferenceSchema>): unknown {
  const media = sortedBy(value.media, byIdNumber).map((item) => ({
    ...item,
    frames: sortedBy(item.frames as Loose[], (frame) => frame.timeMs as number).map((frame) =>
      Object.fromEntries(FRAME_KEYS.map((key) => [key, frame[key]])),
    ),
  }));
  const pins = sortedBy(value.pins, byIdNumber).map((pin) => ({
    ...pin,
    region: roundRegion(pin.region),
  }));
  // `z.record` keeps the input order, so the keys are sorted here (format-spec §7.6).
  const interpretations = Object.fromEntries(
    sortedBy(Object.entries(value.interpretations), ([key]) => sequenceNumber(key)),
  );
  return { ...value, media, pins, interpretations };
}

/** What each file type needs on top of the schema's key order. */
const FILES = {
  library: { schema: LibrarySchema, order: (value: unknown) => value },
  marker: { schema: MediaMarkerSchema, order: (value: unknown) => value },
  reference: {
    schema: ReferenceSchema,
    order: (value: unknown) => canonicalReference(value as z.infer<typeof ReferenceSchema>),
  },
  family: {
    schema: FamilySchema,
    order: (value: unknown) => {
      const family = value as z.infer<typeof FamilySchema>;
      return { ...family, members: [...family.members].sort(targetOrder) };
    },
  },
  glossary: {
    schema: GlossarySchema,
    order: (value: unknown) => {
      const glossary = value as z.infer<typeof GlossarySchema>;
      return { ...glossary, terms: sortedBy(glossary.terms, byId) };
    },
  },
  guardrails: {
    schema: GuardrailsSchema,
    order: (value: unknown) => {
      const file = value as z.infer<typeof GuardrailsSchema>;
      return { ...file, guardrails: sortedBy(file.guardrails, byId) };
    },
  },
  "taste-profile": {
    schema: TasteProfileSchema,
    order: (value: unknown) => {
      const file = value as z.infer<typeof TasteProfileSchema>;
      return { ...file, statements: sortedBy(file.statements, byId) };
    },
  },
  project: { schema: ProjectSchema, order: (value: unknown) => value },
  directions: {
    schema: DirectionsSchema,
    order: (value: unknown) => {
      const file = value as z.infer<typeof DirectionsSchema>;
      return { ...file, directions: sortedBy(file.directions, byIdNumber) };
    },
  },
} as const;

export type FileType = keyof typeof FILES;

/** The value type of each file type. */
export type FileValue<K extends FileType> = z.infer<(typeof FILES)[K]["schema"]>;

/**
 * The canonical value: keys in the schema's order (zod's output follows it), lists sorted as the
 * specification states for each, proportions rounded. The input is not changed.
 *
 * @throws ZodError when `value` does not pass the schema.
 */
export function canonicalize<K extends FileType>(type: K, value: unknown): FileValue<K> {
  const file = FILES[type];
  const parsed: unknown = file.schema.parse(value);
  return file.order(parsed) as FileValue<K>;
}

/** The canonical text of a file: two-space JSON plus one LF, no BOM (format-spec §3.1, §3.3). */
export function serialize<K extends FileType>(type: K, value: unknown): string {
  return `${JSON.stringify(canonicalize(type, value), null, 2)}\n`;
}

/**
 * Whether `bytes` are exactly the canonical form of `value`. A file that validates is canonical
 * if and only if this is true, which covers a BOM, CRLF, other whitespace, key and list order,
 * needless `\u` escapes, numbers such as `1.0` and more than 6 decimals (format-spec §3.3).
 */
export function isCanonical(type: FileType, value: unknown, bytes: Uint8Array): boolean {
  const expected = new TextEncoder().encode(serialize(type, value));
  return expected.length === bytes.length && expected.every((byte, index) => byte === bytes[index]);
}
