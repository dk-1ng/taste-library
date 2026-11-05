import { z } from "zod";
import { checkUpdatedAfterCreated } from "./entries.js";
import { authored, crossCheck, line, Name, Slug, Timestamp, text } from "./shared.js";

/** `projects/<slug>/project.json` (format-spec §12.1, version 1). */
const Intent = z.strictObject({
  what: text(1, 4000),
  forWhom: text(1, 4000),
  userTasks: z.array(line(500)).max(20),
  why: text(1, 4000),
});

const Discarded = z.strictObject({
  text: text(1, 500),
  category: z.enum(["style", "color", "font", "named-direction", "other-visual"]),
});

export const ProjectSchema = z
  .strictObject({
    formatVersion: z.literal(1),
    slug: Slug,
    createdAt: Timestamp,
    updatedAt: Timestamp,
    name: Name,
    intent: authored(Intent, { inputSha256: "null" }).nullable(),
    discarded: z.array(Discarded).max(500),
  })
  .check(crossCheck(checkUpdatedAfterCreated));

export type Project = z.infer<typeof ProjectSchema>;
