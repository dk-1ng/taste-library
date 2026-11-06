import type { SchemaSet } from "../../../src/format.js";
import { DirectionsSchema } from "../../../src/schemas/v1/directions.js";
import { FamilySchema } from "../../../src/schemas/v1/family.js";
import { GuardrailsSchema } from "../../../src/schemas/v1/guardrails.js";
import { LibrarySchema } from "../../../src/schemas/v1/library.js";
import { MediaMarkerSchema } from "../../../src/schemas/v1/marker.js";
import { ReferenceSchema } from "../../../src/schemas/v1/reference.js";
import { TasteProfileSchema } from "../../../src/schemas/v1/taste-profile.js";
import { GlossaryTermSchema } from "./glossary-term.js";
import { atVersion2 } from "./at-version-2.js";
import { ProjectSchema } from "./project.js";

/**
 * The schema set of the test-only format version 2 (docs/design.md section 15, "Core test
 * approach"), built from the frozen version 1 modules. Test-only: it lives outside `src/`, so it
 * can never reach `dist/`.
 *
 * - Every file has `formatVersion` 2 (`atVersion2`).
 * - `glossary.json` is gone: each term is a `glossary-term` file of its own.
 * - `project.json` gains the library's `language`.
 * - The media marker has its own version (format-spec §15.1), which the library's version 2 does
 *   not change.
 */
export const v2Schemas: SchemaSet = {
  library: atVersion2(LibrarySchema),
  marker: MediaMarkerSchema,
  reference: atVersion2(ReferenceSchema),
  family: atVersion2(FamilySchema),
  "glossary-term": GlossaryTermSchema,
  guardrails: atVersion2(GuardrailsSchema),
  "taste-profile": atVersion2(TasteProfileSchema),
  project: ProjectSchema,
  directions: atVersion2(DirectionsSchema),
};
