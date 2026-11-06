// @tastelib/core/browser: pure modules only; nothing here touches the operating system.

export {
  planDirectionDeletion,
  planFamilyDeletion,
  planGuardrailDeletion,
  planPinDeletion,
  planReferenceDeletion,
} from "./changes/delete.js";
export type { FileChange, Plan, Skipped, SkipReason } from "./changes/plan.js";
export { skipReasonOf } from "./changes/plan.js";
export type { PieceMatcher } from "./changes/remove-links.js";
export {
  pieceMatcher,
  withoutDirectionLink,
  withoutFamilyLink,
  withoutGuardrailLink,
  withoutPieceLinks,
} from "./changes/remove-links.js";
export type {
  EntryClass,
  FileKind,
  FormatLayout,
  FormatRegistry,
  FormatVersionSpec,
  LibraryFileKind,
  SchemaSet,
} from "./format.js";
export {
  applySteps,
  CURRENT_FORMAT_VERSION,
  classifyEntry,
  currentLayout,
  currentSpec,
  FORMAT_REGISTRY,
} from "./format.js";
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
export type {
  Backlink,
  FamilyMember,
  FamilyOfPiece,
  IndexedFamily,
  IndexedReference,
  IndexInput,
  LibraryIndex,
} from "./library-index/build.js";
export { buildIndex } from "./library-index/build.js";
export type { LinkState, LinkTarget, Targets } from "./library-index/targets.js";
export { buildTargets, targetFileOf, targetKey } from "./library-index/targets.js";
export type { VersionSummary } from "./library-index/versions.js";
export { versionSummary } from "./library-index/versions.js";
export type { LibraryValues, MigrationStep } from "./migrations/steps.js";
export {
  CURRENT_MARKER_VERSION,
  MARKER_REGISTRY,
  type MarkerMigration,
  type MarkerRegistry,
  type MarkerVersionSpec,
  migrateMarker,
  serializeMarker,
} from "./marker.js";
export type { DerivedState, ReferenceForState } from "./model/derived-state.js";
export { derivedState } from "./model/derived-state.js";
export type {
  AuthoredValue,
  Effective,
  LinkWeight,
  ReviewedLinkValue,
} from "./model/effective.js";
export { effectiveOf, linkWeight } from "./model/effective.js";
export { roundAxis, roundRegion } from "./model/region.js";
export { differsBesidesUpdatedAt, laterOf, stampFile } from "./model/timestamps.js";
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
export type { CrossFile, CrossOptions, LinkEvent } from "./validation/cross.js";
export { crossFileIssues } from "./validation/cross.js";
export type { FileCheck, FileStatus } from "./validation/file.js";
export { checkLibraryFile } from "./validation/file.js";
export type { Issue, IssueCode, Severity } from "./validation/issue.js";
export { ISSUE_SEVERITY, makeIssue } from "./validation/issue.js";
export type { EntryRead, LibraryEntry, Snapshot, SnapshotFile } from "./validation/library.js";
export {
  assembleSnapshot,
  buildSnapshot,
  checkEntry,
  reportOf,
} from "./validation/library.js";
export type { Report } from "./validation/report.js";
export {
  buildReport,
  compareIssues,
  countIssues,
  mediaNotChecked,
  REPORT_VERSION,
  sortIssues,
} from "./validation/report.js";
export { describePath, issuesFromZod, pointerOf, validateValue } from "./validation/zod-issues.js";
