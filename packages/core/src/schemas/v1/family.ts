import { z } from "zod";
import { checkUpdatedAfterCreated, uniqueList } from "./entries.js";
import {
  authored,
  crossCheck,
  Name,
  objectOf,
  PieceRef,
  reviewedLink,
  Slug,
  TagList,
  Timestamp,
  text,
} from "./shared.js";

/** `families/<slug>.json` (format-spec §8, version 1). */
const Member = reviewedLink(PieceRef);

export const FamilySchema = z
  .strictObject({
    formatVersion: z.literal(1),
    slug: Slug,
    createdAt: Timestamp,
    updatedAt: Timestamp,
    description: authored(
      z.strictObject({ name: Name, meaning: text(1, 4000), vocabulary: TagList }),
      { inputSha256: "null" },
    ),
    members: uniqueList(
      Member,
      10000,
      (member) => {
        const target = objectOf(member).target;
        return typeof target === "string" && PieceRef.safeParse(target).success
          ? target
          : undefined;
      },
      ["target"],
    ),
  })
  .check(crossCheck(checkUpdatedAfterCreated));

export type Family = z.infer<typeof FamilySchema>;
