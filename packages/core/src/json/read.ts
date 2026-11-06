import { type Issue, makeIssue } from "../validation/issue.js";

/**
 * The strict reader of library JSON files (docs/design.md section 4, "Reading library files";
 * format-spec §3.1 and §3.2). Pure: bytes in, a value or issues out. It is an RFC 8259 parser with
 * an explicit stack, never recursion, so deep input cannot overflow the call stack.
 */

/** RFC 8259 section 9 lets a parser limit nesting; the format does (docs/design.md section 4). */
export const MAX_NESTING = 64;

export interface ReadOk {
  ok: true;
  value: unknown;
  /** The bytes started with a UTF-8 byte order mark. */
  hadBom: boolean;
  /** The text contained a CR character (CRLF line endings). */
  hadCr: boolean;
}

export interface ReadFailed {
  ok: false;
  issues: Issue[];
}

export type ReadResult = ReadOk | ReadFailed;

/** Escapes one reference token of a JSON Pointer (RFC 6901 section 3). */
export function escapePointerToken(token: string): string {
  return token.replaceAll("~", "~0").replaceAll("/", "~1");
}

class SyntaxFailure extends Error {
  readonly position: number;
  constructor(message: string, position: number) {
    super(message);
    this.position = position;
  }
}

const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
const NUMBER = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
const SIMPLE_ESCAPES: Record<string, string> = {
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
};

interface Frame {
  readonly pointer: string;
  /** Present for an array. */
  readonly list: unknown[] | null;
  /** Present for an object. */
  readonly record: Record<string, unknown> | null;
  readonly keys: Set<string> | null;
  key: string;
}

function lineAndColumn(text: string, position: number): string {
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < position; i++) {
    const code = text.charCodeAt(i);
    if (code === 0x0a || (code === 0x0d && text.charCodeAt(i + 1) !== 0x0a)) {
      line++;
      lineStart = i + 1;
    }
  }
  return `line ${line}, column ${position - lineStart + 1}`;
}

function describeAt(text: string, position: number): string {
  if (position >= text.length) return "unexpected end of input";
  const char = String.fromCodePoint(text.codePointAt(position) ?? 0);
  return `unexpected character ${JSON.stringify(char)}`;
}

/** Reads a library file's bytes. `file` is the path relative to the library, used in issues. */
export function readLibraryJson(bytes: Uint8Array, file: string): ReadResult {
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return {
      ok: false,
      issues: [makeIssue("invalid-encoding", file, null, "The file is not valid UTF-8.")],
    };
  }
  const hadBom = decoded.charCodeAt(0) === 0xfeff;
  const text = hadBom ? decoded.slice(1) : decoded;
  const hadCr = text.includes("\r");
  const issues: Issue[] = [];
  let pos = 0;

  const fail = (message: string, at = pos): never => {
    throw new SyntaxFailure(message, at);
  };

  const skipWhitespace = (): void => {
    while (pos < text.length) {
      const code = text.charCodeAt(pos);
      if (code === 0x20 || code === 0x0a || code === 0x0d || code === 0x09) pos++;
      else break;
    }
  };

  /** Reads the string that starts at `pos` (a quote) and leaves `pos` after the closing quote. */
  const readString = (): string => {
    pos++;
    let out = "";
    let chunk = pos;
    while (true) {
      if (pos >= text.length) return fail("unterminated string", pos);
      const code = text.charCodeAt(pos);
      if (code === 0x22) {
        out += text.slice(chunk, pos);
        pos++;
        return out;
      }
      if (code < 0x20) return fail("unescaped control character in string");
      if (code !== 0x5c) {
        pos++;
        continue;
      }
      out += text.slice(chunk, pos);
      const letter = text[pos + 1] ?? "";
      const simple = SIMPLE_ESCAPES[letter];
      if (simple !== undefined) {
        out += simple;
        pos += 2;
      } else if (letter === "u") {
        const hex = text.slice(pos + 2, pos + 6);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) return fail("invalid \\u escape", pos);
        out += String.fromCharCode(Number.parseInt(hex, 16));
        pos += 6;
      } else {
        return fail("invalid escape sequence", pos);
      }
      chunk = pos;
    }
  };

  const stack: Frame[] = [];
  let root: unknown;

  const childPointer = (frame: Frame | undefined, key?: string): string => {
    if (frame === undefined) return "";
    const token = frame.list !== null ? String(frame.list.length) : (key ?? frame.key);
    return `${frame.pointer}/${escapePointerToken(token)}`;
  };

  const checkSurrogates = (value: string, pointer: string): void => {
    if (LONE_SURROGATE.test(value)) {
      issues.push(
        makeIssue(
          "invalid-encoding",
          file,
          pointer,
          "A string contains a lone surrogate (an unpaired \\u escape).",
        ),
      );
    }
  };

  const open = (frame: Frame): void => {
    if (stack.length >= MAX_NESTING) fail(`nested deeper than ${MAX_NESTING} levels`);
    stack.push(frame);
    pos++;
  };

  /** Reads `"key" :` inside the object on top of the stack. */
  const readKey = (frame: Frame): void => {
    skipWhitespace();
    if (text.charCodeAt(pos) !== 0x22) fail(`${describeAt(text, pos)}, expected a key`);
    const key = readString();
    const pointer = `${frame.pointer}/${escapePointerToken(key)}`;
    checkSurrogates(key, pointer);
    if (frame.keys?.has(key)) {
      issues.push(
        makeIssue("duplicate-key", file, pointer, `The key ${JSON.stringify(key)} appears twice.`),
      );
    }
    frame.keys?.add(key);
    skipWhitespace();
    if (text.charCodeAt(pos) !== 0x3a) fail(`${describeAt(text, pos)}, expected ":"`);
    pos++;
    frame.key = key;
  };

  /** Stores a finished value in its parent, or as the root. */
  const attach = (value: unknown): boolean => {
    const parent = stack[stack.length - 1];
    if (parent === undefined) {
      root = value;
      return true;
    }
    if (parent.list !== null) {
      parent.list.push(value);
    } else if (parent.record !== null) {
      if (parent.key === "__proto__") {
        // An assignment would set the prototype; defineProperty keeps it an own property, as
        // JSON.parse does. Every other member of Object.prototype is a writable data property,
        // so assigning to it creates an own property, and is much faster.
        Object.defineProperty(parent.record, parent.key, {
          value,
          writable: true,
          enumerable: true,
          configurable: true,
        });
      } else {
        parent.record[parent.key] = value;
      }
    }
    return false;
  };

  try {
    let done = false;
    let expectValue = true;
    while (!done) {
      if (expectValue) {
        skipWhitespace();
        const parent = stack[stack.length - 1];
        const code = text.charCodeAt(pos);
        let value: unknown;
        let complete = true;
        if (code === 0x7b) {
          const frame: Frame = {
            pointer: childPointer(parent),
            list: null,
            record: {},
            keys: new Set(),
            key: "",
          };
          open(frame);
          skipWhitespace();
          if (text.charCodeAt(pos) === 0x7d) {
            pos++;
            stack.pop();
            value = frame.record;
          } else {
            readKey(frame);
            complete = false;
          }
        } else if (code === 0x5b) {
          const frame: Frame = {
            pointer: childPointer(parent),
            list: [],
            record: null,
            keys: null,
            key: "",
          };
          open(frame);
          skipWhitespace();
          if (text.charCodeAt(pos) === 0x5d) {
            pos++;
            stack.pop();
            value = frame.list;
          } else {
            complete = false;
          }
        } else if (code === 0x22) {
          const pointer = childPointer(parent);
          const text1 = readString();
          checkSurrogates(text1, pointer);
          value = text1;
        } else if (code === 0x2d || (code >= 0x30 && code <= 0x39)) {
          NUMBER.lastIndex = pos;
          const match = NUMBER.exec(text);
          if (match === null) return fail("invalid number");
          pos += match[0].length;
          value = Number(match[0]);
        } else if (text.startsWith("true", pos)) {
          pos += 4;
          value = true;
        } else if (text.startsWith("false", pos)) {
          pos += 5;
          value = false;
        } else if (text.startsWith("null", pos)) {
          pos += 4;
          value = null;
        } else {
          return fail(describeAt(text, pos));
        }
        if (!complete) continue;
        if (attach(value)) done = true;
        else expectValue = false;
      } else {
        // After a value inside a container: a comma or the closing bracket.
        skipWhitespace();
        const frame = stack[stack.length - 1] as Frame;
        const code = text.charCodeAt(pos);
        if (code === 0x2c) {
          pos++;
          if (frame.record !== null) readKey(frame);
          expectValue = true;
        } else if (code === (frame.list !== null ? 0x5d : 0x7d)) {
          pos++;
          stack.pop();
          if (attach(frame.list ?? frame.record)) done = true;
        } else {
          return fail(
            `${describeAt(text, pos)}, expected "," or "${frame.list !== null ? "]" : "}"}"`,
          );
        }
      }
    }
    skipWhitespace();
    if (pos < text.length) fail(`${describeAt(text, pos)} after the value`);
  } catch (error) {
    if (!(error instanceof SyntaxFailure)) throw error;
    issues.push(
      makeIssue(
        "invalid-json",
        file,
        null,
        `Not valid JSON at ${lineAndColumn(text, error.position)}: ${error.message}.`,
      ),
    );
  }

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: root, hadBom, hadCr };
}
