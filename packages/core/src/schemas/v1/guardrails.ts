import { z } from "zod";
import { checkUniqueIds, checkUpdatedAfterCreated, uniqueList } from "./entries.js";
import {
  authored,
  crossCheck,
  GuardrailId,
  isGuardrailId,
  objectOf,
  PieceRef,
  Timestamp,
  text,
} from "./shared.js";

/** `guardrails.json` (format-spec §10, version 1). */
const Guardrail = z
  .strictObject({
    id: GuardrailId,
    createdAt: Timestamp,
    updatedAt: Timestamp,
    sources: uniqueList(PieceRef, 100),
    rule: authored(z.strictObject({ text: text(1, 500) }), { inputSha256: "null" }),
  })
  .check(crossCheck(checkUpdatedAfterCreated));

export const GuardrailsSchema = z
  .strictObject({
    formatVersion: z.literal(1),
    guardrails: z.array(Guardrail).max(10000),
  })
  .check(
    crossCheck((raw, ctx) =>
      checkUniqueIds(objectOf(raw).guardrails, "guardrails", isGuardrailId, ctx),
    ),
  );

export type Guardrails = z.infer<typeof GuardrailsSchema>;
