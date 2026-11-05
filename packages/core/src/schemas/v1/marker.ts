import { z } from "zod";
import { LibraryId } from "./shared.js";

/** `tastelib-media.json`, the media folder's marker (format-spec §6.1, version 1). */
export const MediaMarkerSchema = z.strictObject({
  formatVersion: z.literal(1),
  libraryId: LibraryId,
});

export type MediaMarker = z.infer<typeof MediaMarkerSchema>;
