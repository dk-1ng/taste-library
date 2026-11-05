import { z } from "zod";
import { LanguageTag, LibraryId, Name, Timestamp } from "./shared.js";

/** `library.json` (format-spec §5.1, version 1). */
export const LibrarySchema = z.strictObject({
  formatVersion: z.literal(1),
  id: LibraryId,
  name: Name,
  language: LanguageTag,
  createdAt: Timestamp,
});

export type Library = z.infer<typeof LibrarySchema>;
