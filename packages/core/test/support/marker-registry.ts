import { z } from "zod";
import { MARKER_REGISTRY, type MarkerRegistry } from "../../src/marker.js";
import { LibraryId } from "../../src/schemas/v1/shared.js";

/**
 * A test-only marker registry with a version 2 on top of the production version 1 (docs/design.md
 * section 15, "Core test approach"): the step sets `formatVersion` 2 and adds one field.
 */
const MarkerV2 = z.strictObject({
  formatVersion: z.literal(2),
  libraryId: LibraryId,
  createdBy: z.string(),
});

const v1 = MARKER_REGISTRY.versions[1];
if (v1 === undefined) throw new Error("The production marker registry has no version 1.");

export const TEST_MARKER_REGISTRY: MarkerRegistry = {
  current: 2,
  versions: { 1: v1, 2: { schema: MarkerV2 } },
  steps: {
    1: (marker) => ({ ...(marker as object), formatVersion: 2, createdBy: "migration" }),
  },
};
