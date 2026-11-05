// @tastelib/core/browser: pure modules only; nothing here touches the operating system.

export type { FileType, FileValue } from "./json/canonical.js";
export { canonicalIssue, canonicalize, isCanonical, serialize } from "./json/canonical.js";
export { roundAxis, roundRegion } from "./model/region.js";
