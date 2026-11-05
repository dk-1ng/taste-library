import { describe, expect, it } from "vitest";
import * as browser from "./browser.js";

describe("the browser entry", () => {
  it("exports the reader, the schemas, the issue helpers, the canonical writer and the plans", () => {
    for (const name of [
      "readLibraryJson",
      "ReferenceSchema",
      "LibrarySchema",
      "v1Shared",
      "makeIssue",
      "validateValue",
      "serialize",
      "canonicalize",
      "isCanonical",
      "canonicalIssue",
      "roundRegion",
      "FORMAT_REGISTRY",
      "checkLibraryFile",
      "crossFileIssues",
      "buildSnapshot",
      "reportOf",
      "buildReport",
      "skipReasonOf",
      "pieceMatcher",
      "withoutPieceLinks",
      "planPinDeletion",
      "planReferenceDeletion",
      "planFamilyDeletion",
      "planGuardrailDeletion",
      "planDirectionDeletion",
    ]) {
      expect(browser, name).toHaveProperty(name);
    }
  });
});
