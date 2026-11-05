import { z } from "zod";
import { checkUniqueIds, checkUpdatedAfterCreated, uniqueList } from "./entries.js";
import {
  authored,
  crossCheck,
  isTermId,
  objectOf,
  PieceRef,
  Tag,
  TermId,
  Timestamp,
  text,
} from "./shared.js";

/** `glossary.json` (format-spec §9, version 1). */
const Term = z
  .strictObject({
    id: TermId,
    createdAt: Timestamp,
    updatedAt: Timestamp,
    pieces: uniqueList(PieceRef, 100),
    entry: authored(z.strictObject({ term: Tag, definition: text(1, 4000) }), {
      inputSha256: "null",
    }),
  })
  .check(crossCheck(checkUpdatedAfterCreated));

export const GlossarySchema = z
  .strictObject({
    formatVersion: z.literal(1),
    terms: z.array(Term).max(10000),
  })
  .check(crossCheck((raw, ctx) => checkUniqueIds(objectOf(raw).terms, "terms", isTermId, ctx)));

export type Glossary = z.infer<typeof GlossarySchema>;
