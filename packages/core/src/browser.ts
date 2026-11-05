// @tastelib/core/browser: pure modules only; nothing here touches the operating system.

export type { ReadFailed, ReadOk, ReadResult } from "./json/read.js";
export { escapePointerToken, MAX_NESTING, readLibraryJson } from "./json/read.js";
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
