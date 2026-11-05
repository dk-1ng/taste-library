// @tastelib/core/browser: pure modules only; nothing here touches the operating system.

export type { IdOptions, RandomSource, RefIdOptions } from "./ids/random.js";
export {
  newGuardrailId,
  newLibraryId,
  newRefId,
  newStatementId,
  newTermId,
  randomPart,
} from "./ids/random.js";
export type { Issued, SequencePrefix } from "./ids/sequence.js";
export { issueNext } from "./ids/sequence.js";
export type { SlugKind, SlugOptions } from "./ids/slug.js";
export { deriveSlug, MAX_SLUG_LENGTH, makeSlug, shortenSlug } from "./ids/slug.js";
export type { FileType, FileValue } from "./json/canonical.js";
export { canonicalIssue, canonicalize, isCanonical, serialize } from "./json/canonical.js";
export type { ReadFailed, ReadOk, ReadResult } from "./json/read.js";
export { escapePointerToken, MAX_NESTING, readLibraryJson } from "./json/read.js";
export { roundAxis, roundRegion } from "./model/region.js";
export { type Directions, DirectionsSchema } from "./schemas/v1/directions.js";
export { type Family, FamilySchema } from "./schemas/v1/family.js";
export { type Glossary, GlossarySchema } from "./schemas/v1/glossary.js";
export { type Guardrails, GuardrailsSchema } from "./schemas/v1/guardrails.js";
export { type Library, LibrarySchema } from "./schemas/v1/library.js";
export { type MediaMarker, MediaMarkerSchema } from "./schemas/v1/marker.js";
export { type Project, ProjectSchema } from "./schemas/v1/project.js";
export { type Reference, ReferenceSchema } from "./schemas/v1/reference.js";
export * as v1Shared from "./schemas/v1/shared.js";
export { type TasteProfile, TasteProfileSchema } from "./schemas/v1/taste-profile.js";
export type { Issue, IssueCode, Severity } from "./validation/issue.js";
export { ISSUE_SEVERITY, makeIssue } from "./validation/issue.js";
export { describePath, issuesFromZod, pointerOf, validateValue } from "./validation/zod-issues.js";
