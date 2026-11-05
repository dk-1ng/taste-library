import { z } from "zod";
import { checkUniqueIds, checkUpdatedAfterCreated, uniqueList } from "./entries.js";
import {
  addRuleIssue,
  authored,
  countOf,
  crossCheck,
  DirectionId,
  GuardrailId,
  integer,
  isDirectionId,
  listOf,
  Name,
  objectOf,
  PieceRef,
  Slug,
  sequenceNumber,
  stringOf,
  Timestamp,
  text,
} from "./shared.js";

/** `projects/<slug>/directions.json` (format-spec §12.2, version 1). */
const Direction = z
  .strictObject({
    id: DirectionId,
    createdAt: Timestamp,
    updatedAt: Timestamp,
    family: Slug.nullable(),
    pieces: uniqueList(PieceRef, 100),
    guardrails: uniqueList(GuardrailId, 100),
    plan: authored(z.strictObject({ title: Name, why: text(1, 4000) }), { inputSha256: "null" }),
  })
  .check(crossCheck(checkUpdatedAfterCreated));

export const DirectionsSchema = z
  .strictObject({
    formatVersion: z.literal(1),
    directions: z.array(Direction).max(50),
    lastIssued: z.strictObject({ direction: integer(0) }),
  })
  .check(
    crossCheck((raw, ctx) => {
      const file = objectOf(raw);
      checkUniqueIds(file.directions, "directions", isDirectionId, ctx);
      const issued = countOf(objectOf(file.lastIssued).direction);
      if (issued === undefined) return;
      const highest = Math.max(
        0,
        ...listOf(file.directions).flatMap((entry) => {
          const id = stringOf(objectOf(entry).id);
          return id !== undefined && isDirectionId(id) ? [sequenceNumber(id)] : [];
        }),
      );
      if (issued < highest) {
        addRuleIssue(
          ctx,
          ["lastIssued", "direction"],
          `must be at least ${highest}, the highest direction id in use.`,
        );
      }
    }),
  );

export type Directions = z.infer<typeof DirectionsSchema>;
