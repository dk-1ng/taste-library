import { z } from "zod";
import { FORMAT_REGISTRY, type FormatRegistry, type SchemaSet } from "../../src/format.js";

/**
 * A test-only registry with a version 2 on top of the production version 1 (docs/design.md
 * section 15, "Core test approach"): every file type accepts any object whose `formatVersion` is
 * 2, which is enough to exercise the version codes before the first real step exists.
 */
const anyV2 = z.looseObject({ formatVersion: z.literal(2) });

const v1 = FORMAT_REGISTRY.versions[1];
if (v1 === undefined) throw new Error("The production registry has no version 1.");

const v2Schemas: SchemaSet = {
  library: anyV2,
  reference: anyV2,
  family: anyV2,
  glossary: anyV2,
  guardrails: anyV2,
  "taste-profile": anyV2,
  project: anyV2,
  directions: anyV2,
};

export const TEST_REGISTRY: FormatRegistry = {
  current: 2,
  versions: { 1: v1, 2: { schemas: v2Schemas, layout: v1.layout } },
};
