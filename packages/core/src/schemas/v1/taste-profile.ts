import { z } from "zod";
import { checkUniqueIds, checkUpdatedAfterCreated, uniqueList } from "./entries.js";
import {
  authored,
  crossCheck,
  isStatementId,
  objectOf,
  PieceRef,
  StatementId,
  Timestamp,
  text,
} from "./shared.js";

/** `taste-profile.json` (format-spec §11, version 1). */
const Statement = z
  .strictObject({
    id: StatementId,
    createdAt: Timestamp,
    updatedAt: Timestamp,
    evidence: uniqueList(PieceRef, 100),
    statement: authored(
      z.strictObject({
        kind: z.enum(["like", "rejection", "contradiction"]),
        text: text(1, 2000),
      }),
      { inputSha256: "null" },
    ),
  })
  .check(crossCheck(checkUpdatedAfterCreated));

export const TasteProfileSchema = z
  .strictObject({
    formatVersion: z.literal(1),
    statements: z.array(Statement).max(2000),
  })
  .check(
    crossCheck((raw, ctx) =>
      checkUniqueIds(objectOf(raw).statements, "statements", isStatementId, ctx),
    ),
  );

export type TasteProfile = z.infer<typeof TasteProfileSchema>;
