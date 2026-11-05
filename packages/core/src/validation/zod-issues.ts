import type { z } from "zod";
import { escapePointerToken } from "../json/read.js";
import { type Issue, type IssueCode, makeIssue } from "./issue.js";

/**
 * Maps the issues of a zod parse to the issues of format-spec §16.3: a code from §16.2, a JSON
 * Pointer and an English message that names the field ("pins[0].region.w: must be greater than 0.").
 * Pure.
 *
 * - A custom issue carries the `params.code` of the schema that raised it (`duplicate-id`,
 *   `broken-local-link`); every other issue is a `schema-violation`.
 * - An unknown field is one issue per field, pointing at the field.
 * - The messages of rules the schemas write themselves are kept; the generic zod issues (type,
 *   missing field, bounds, enums) get their message here, so that the wording never depends on zod.
 *
 * Parse with `{ reportInput: true }`: a missing field is told from a wrong type by the input.
 */

type Segment = string | number | symbol;

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** `pins[0].region.w` for a path; `the file` for the root. */
export function describePath(path: readonly Segment[]): string {
  if (path.length === 0) return "the file";
  let out = "";
  for (const segment of path) {
    if (typeof segment === "number") out += `[${segment}]`;
    else if (IDENTIFIER.test(String(segment)))
      out += out === "" ? String(segment) : `.${String(segment)}`;
    else out += `[${JSON.stringify(String(segment))}]`;
  }
  return out;
}

/** The RFC 6901 JSON Pointer for a path; `null` for the root. */
export function pointerOf(path: readonly Segment[]): string | null {
  if (path.length === 0) return null;
  return path.map((segment) => `/${escapePointerToken(String(segment))}`).join("");
}

const TYPE_NAMES: Record<string, string> = {
  string: "a string",
  number: "a number",
  int: "an integer",
  boolean: "a boolean",
  object: "an object",
  array: "an array",
  record: "an object",
  null: "null",
};

function quoted(values: readonly unknown[]): string {
  return values.map((value) => JSON.stringify(value)).join(", ");
}

function genericMessage(issue: z.core.$ZodIssue): string {
  switch (issue.code) {
    case "invalid_type": {
      if (issue.input === undefined) return "is required.";
      return `must be ${TYPE_NAMES[issue.expected] ?? issue.expected}.`;
    }
    case "invalid_value":
      return issue.values.length === 1
        ? `must be ${quoted(issue.values)}.`
        : `must be one of ${quoted(issue.values)}.`;
    case "invalid_union": {
      if ("discriminator" in issue && issue.discriminator !== undefined) {
        const parent = issue.input;
        const absent =
          typeof parent === "object" && parent !== null && !(String(issue.discriminator) in parent);
        if (absent) return "is required.";
        return `must be one of ${quoted((issue as { options?: unknown[] }).options ?? [])}.`;
      }
      return "does not match any allowed form.";
    }
    case "too_small": {
      const minimum = String(issue.minimum);
      if (issue.origin === "array")
        return `must have at least ${minimum} ${minimum === "1" ? "item" : "items"}.`;
      return issue.inclusive ? `must be at least ${minimum}.` : `must be greater than ${minimum}.`;
    }
    case "too_big": {
      const maximum = String(issue.maximum);
      if (issue.origin === "array")
        return `must have at most ${maximum} ${maximum === "1" ? "item" : "items"}.`;
      return issue.inclusive ? `must be at most ${maximum}.` : `must be less than ${maximum}.`;
    }
    case "invalid_key":
      return "is not a valid key.";
    default:
      return issue.message;
  }
}

function codeOf(issue: z.core.$ZodIssue): IssueCode {
  if (issue.code === "custom") {
    const code = (issue.params as { code?: unknown } | undefined)?.code;
    if (code === "duplicate-id" || code === "broken-local-link") return code;
  }
  return "schema-violation";
}

/** Converts the issues of a failed parse. `file` is the path relative to the library, with `/`. */
export function issuesFromZod(error: z.ZodError, file: string): Issue[] {
  const out: Issue[] = [];
  const seen = new Set<string>();
  const add = (code: IssueCode, path: readonly Segment[], message: string): void => {
    const key = `${code}\u0000${pointerOf(path)}\u0000${message}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(makeIssue(code, file, pointerOf(path), `${describePath(path)}: ${message}`));
  };

  for (const issue of error.issues) {
    if (issue.code === "unrecognized_keys") {
      for (const key of issue.keys)
        add("schema-violation", [...issue.path, key], "is not a field of this file.");
    } else if (issue.code === "custom") {
      add(codeOf(issue), issue.path, issue.message);
    } else if (issue.code === "invalid_key") {
      // The path of a key issue is the record; the offending key is the last segment already.
      add("schema-violation", issue.path, genericMessage(issue));
    } else {
      add("schema-violation", issue.path, genericMessage(issue));
    }
  }
  return out;
}

/** Parses a value with a schema and returns its issues (empty when it is valid). Always reports the input, so messages are right. */
export function validateValue(schema: z.ZodType, value: unknown, file: string): Issue[] {
  const result = schema.safeParse(value, { reportInput: true });
  return result.success ? [] : issuesFromZod(result.error, file);
}
