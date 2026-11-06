import type { z } from "zod";
import { MediaMarkerSchema } from "./schemas/v1/marker.js";

/**
 * The media marker's own registry (docs/design.md section 3; format-spec §6.1, §15.1). It is
 * separate from the library's, because the marker carries its own `formatVersion`: the media
 * folder may be absent from a computer, or still syncing, when the library migrates. Pure.
 *
 * A tool that supports marker version N reads 1 to N and writes only N. At version 1 there is no
 * step; tests pass a registry with a test-only step v1 to v2.
 */

export interface MarkerVersionSpec {
  /** The schema of the marker at this version; its key order is the canonical order. */
  schema: z.ZodType;
}

export interface MarkerRegistry {
  /** The highest marker version this tool supports. */
  current: number;
  versions: Readonly<Record<number, MarkerVersionSpec>>;
  /** `steps[n]` turns a version n marker into a version n + 1 marker: pure and deterministic. */
  steps: Readonly<Record<number, (marker: unknown) => unknown>>;
}

export const CURRENT_MARKER_VERSION = 1;

export const MARKER_REGISTRY: MarkerRegistry = {
  current: CURRENT_MARKER_VERSION,
  versions: { 1: { schema: MediaMarkerSchema } },
  steps: {},
};

export type MarkerMigration =
  | { ok: true; value: unknown; from: number }
  | { ok: false; reason: string };

/**
 * Applies the steps from `from` up to the current version, in memory, and validates the result
 * against the current schema. `value` must already pass the schema of version `from`.
 */
export function migrateMarker(
  registry: MarkerRegistry,
  value: unknown,
  from: number,
): MarkerMigration {
  let current = value;
  for (let version = from; version < registry.current; version += 1) {
    const step = registry.steps[version];
    if (step === undefined) return { ok: false, reason: `no step from version ${version}` };
    current = step(current);
  }
  const schema = registry.versions[registry.current]?.schema;
  if (schema === undefined) throw new Error(`The registry has no version ${registry.current}.`);
  const parsed = schema.safeParse(current);
  if (!parsed.success) {
    return { ok: false, reason: `the migrated marker is invalid: ${parsed.error.message}` };
  }
  return { ok: true, value: parsed.data, from };
}

/** Two-space JSON plus one LF, keys in the current schema's order (same form as the library's files). */
export function serializeMarker(registry: MarkerRegistry, value: unknown): string {
  const schema = registry.versions[registry.current]?.schema;
  if (schema === undefined) throw new Error(`The registry has no version ${registry.current}.`);
  return `${JSON.stringify(schema.parse(value), null, 2)}\n`;
}
