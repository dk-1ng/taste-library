import { z } from "zod";
import { checkUpdatedAfterCreated } from "../../../src/schemas/v1/entries.js";
import { GlossarySchema } from "../../../src/schemas/v1/glossary.js";
import { crossCheck } from "../../../src/schemas/v1/shared.js";

/**
 * `glossary/<term-id>.json` of the test-only version 2 (docs/design.md section 15, "Core test
 * approach"): one term of the version 1 glossary per file, with `formatVersion` 2 first. The
 * term's fields and rules are version 1's, taken from the frozen glossary schema.
 */
const Term = GlossarySchema.shape.terms.element;

export const GlossaryTermSchema = z
  .strictObject({ formatVersion: z.literal(2), ...Term.shape })
  .check(crossCheck(checkUpdatedAfterCreated));
