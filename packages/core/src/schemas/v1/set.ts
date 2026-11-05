import type { z } from "zod";
import { DirectionsSchema } from "./directions.js";
import { FamilySchema } from "./family.js";
import { GlossarySchema } from "./glossary.js";
import { GuardrailsSchema } from "./guardrails.js";
import { LibrarySchema } from "./library.js";
import { MediaMarkerSchema } from "./marker.js";
import { ProjectSchema } from "./project.js";
import { ReferenceSchema } from "./reference.js";
import { TasteProfileSchema } from "./taste-profile.js";

/** The schema set of format version 1: one schema for each file type (docs/design.md section 3, "Core modules and API"). */
export const v1Schemas = {
  library: LibrarySchema,
  marker: MediaMarkerSchema,
  reference: ReferenceSchema,
  family: FamilySchema,
  glossary: GlossarySchema,
  guardrails: GuardrailsSchema,
  "taste-profile": TasteProfileSchema,
  project: ProjectSchema,
  directions: DirectionsSchema,
} as const satisfies Record<string, z.ZodType>;
