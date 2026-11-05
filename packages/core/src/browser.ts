// @tastelib/core/browser: pure modules only; nothing here touches the operating system.

export type { ReadFailed, ReadOk, ReadResult } from "./json/read.js";
export { escapePointerToken, MAX_NESTING, readLibraryJson } from "./json/read.js";
export type { Issue, IssueCode, Severity } from "./validation/issue.js";
export { ISSUE_SEVERITY, makeIssue } from "./validation/issue.js";
