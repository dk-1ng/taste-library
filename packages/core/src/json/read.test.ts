import { describe, expect, it } from "vitest";
import { MAX_NESTING, readLibraryJson } from "./read.js";

const enc = (text: string): Uint8Array => new TextEncoder().encode(text);
const read = (text: string) => readLibraryJson(enc(text), "f.json");

function codes(text: string): { code: string; pointer: string | null }[] {
  const result = read(text);
  if (result.ok) throw new Error("expected issues");
  return result.issues.map((i) => ({ code: i.code, pointer: i.pointer }));
}

describe("readLibraryJson: valid input", () => {
  it("reads every JSON type", () => {
    const result = read('{"a":[1,-2.5e2,true,false,null,"x"],"b":{}}');
    expect(result).toMatchObject({ ok: true, hadBom: false, hadCr: false });
    expect(result.ok && result.value).toEqual({ a: [1, -250, true, false, null, "x"], b: {} });
  });

  it("reads non-ASCII text and a valid surrogate pair as one character", () => {
    const result = read('{"n":"Usuário 😀","e":"\\ud83d\\ude00"}');
    const value = result.ok ? (result.value as Record<string, string>) : {};
    expect([...(value.e ?? "")]).toHaveLength(1);
    expect(value.e).toBe("😀");
    expect(value.n).toBe("Usuário 😀");
  });

  it("accepts a BOM and CRLF and records them", () => {
    const result = readLibraryJson(enc('﻿{\r\n"a": 1\r\n}\r\n'), "f.json");
    expect(result).toMatchObject({ ok: true, hadBom: true, hadCr: true, value: { a: 1 } });
  });

  it("keeps __proto__ as an own property and touches no prototype", () => {
    const result = read('{"__proto__":{"x":1}}');
    const value = result.ok ? (result.value as object) : {};
    expect(Object.keys(value)).toEqual(["__proto__"]);
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });

  it("keeps __proto__ an own property whatever its value, as JSON.parse does", () => {
    for (const json of ["null", "1", '"x"', "[]", "{}"]) {
      const text = `{"a":1,"__proto__":${json},"b":2}`;
      const result = read(text);
      const value = result.ok ? (result.value as object) : {};
      expect(Object.keys(value), json).toEqual(["a", "__proto__", "b"]);
      expect(Object.getPrototypeOf(value), json).toBe(Object.prototype);
      expect(value, json).toEqual(JSON.parse(text));
    }
  });

  it("makes keys named like Object.prototype members own properties", () => {
    const keys = [
      "constructor",
      "toString",
      "valueOf",
      "hasOwnProperty",
      "isPrototypeOf",
      "propertyIsEnumerable",
      "toLocaleString",
      "__defineGetter__",
      "__lookupGetter__",
    ];
    const text = `{${keys.map((key, i) => `"${key}":${i}`).join(",")}}`;
    const result = read(text);
    const value = result.ok ? (result.value as Record<string, unknown>) : {};
    expect(Object.keys(value)).toEqual(keys);
    keys.forEach((key, i) => {
      expect(Object.hasOwn(value, key), key).toBe(true);
      expect(value[key], key).toBe(i);
    });
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
    expect(Object.prototype.toString).toBeTypeOf("function");
  });

  it("converts numbers like JSON.parse", () => {
    const text = "[0.1,1e400,-0,12345678901234567890]";
    const result = read(text);
    expect(result.ok && result.value).toEqual(JSON.parse(text));
  });
});

describe("readLibraryJson: invalid-encoding", () => {
  it("rejects bytes that are not UTF-8", () => {
    const result = readLibraryJson(new Uint8Array([0x22, 0xff, 0x22]), "f.json");
    expect(result).toMatchObject({
      ok: false,
      issues: [{ code: "invalid-encoding", pointer: null }],
    });
  });

  it("rejects a lone surrogate escape in a value, with its pointer", () => {
    expect(codes('"\\ud800"')).toEqual([{ code: "invalid-encoding", pointer: "" }]);
    expect(codes('{"a":["\\udc00x"]}')).toEqual([{ code: "invalid-encoding", pointer: "/a/0" }]);
  });

  it("rejects a high surrogate followed by a non-surrogate escape, and a reversed pair", () => {
    expect(codes('"\\ud83d\\u0041"')).toHaveLength(1);
    expect(codes('"\\ude00\\ud83d"')).toHaveLength(1);
  });

  it("rejects a lone surrogate in a key", () => {
    expect(codes('{"k\\ud800":1}')).toEqual([{ code: "invalid-encoding", pointer: "/k\ud800" }]);
  });
});

describe("readLibraryJson: invalid-json", () => {
  it.each([
    ["a comment", '{"a":1} // x'],
    ["a block comment", '/* x */ {"a":1}'],
    ["a trailing comma in an object", '{"a":1,}'],
    ["a trailing comma in an array", "[1,]"],
    ["single quotes", "{'a':1}"],
    ["an unquoted key", "{a:1}"],
    ["a leading zero", "[01]"],
    ["a bare plus", "[+1]"],
    ["a trailing dot", "[1.]"],
    ["NaN", "[NaN]"],
    ["an empty file", ""],
    ["only whitespace", "  \n "],
    ["a truncated file", '{"a":[1,2'],
    ["two values", "{} {}"],
    ["a raw control character in a string", '"a\tb"'],
    ["an invalid escape", '"\\x"'],
    ["a short \\u escape", '"\\u12"'],
    ["a missing colon", '{"a" 1}'],
    ["a missing comma", "[1 2]"],
    ["a mismatched bracket", "[1}"],
  ])("rejects %s", (_name, text) => {
    expect(codes(text)).toEqual([{ code: "invalid-json", pointer: null }]);
  });

  it("names the line and column", () => {
    const result = read('{\n  "a": x\n}');
    expect(!result.ok && result.issues[0]?.message).toContain("line 2, column 8");
  });

  it("counts CRLF as one line break", () => {
    const result = read('{\r\n  "a": x\r\n}');
    expect(!result.ok && result.issues[0]?.message).toContain("line 2, column 8");
  });

  it("allows exactly the maximum nesting and reports one level more", () => {
    const nest = (n: number) => "[".repeat(n) + "]".repeat(n);
    expect(read(nest(MAX_NESTING)).ok).toBe(true);
    const result = read(nest(MAX_NESTING + 1));
    expect(result).toMatchObject({ ok: false, issues: [{ code: "invalid-json" }] });
    expect(!result.ok && result.issues[0]?.message).toContain("nested deeper than 64 levels");
  });

  it("never overflows the stack on very deep input", () => {
    const deep = "[".repeat(2_000_000);
    expect(codes(deep)).toEqual([{ code: "invalid-json", pointer: null }]);
    const deepObjects = '{"a":'.repeat(500_000);
    expect(codes(deepObjects)).toEqual([{ code: "invalid-json", pointer: null }]);
  });
});

describe("readLibraryJson: duplicate-key", () => {
  it('reports {"a":1,"a":2} at /a and gives no value', () => {
    const result = read('{"a":1,"a":2}');
    expect(result.ok).toBe(false);
    expect(!result.ok && result.issues).toMatchObject([
      { code: "duplicate-key", severity: "error", file: "f.json", pointer: "/a" },
    ]);
  });

  it("reports a nested duplicate with its full pointer", () => {
    expect(codes('{"pins":[{"x":1},{"note":"a","note":"b"}]}')).toEqual([
      { code: "duplicate-key", pointer: "/pins/1/note" },
    ]);
  });

  it("compares decoded keys", () => {
    expect(codes('{"a":1,"\\u0061":2}')).toEqual([{ code: "duplicate-key", pointer: "/a" }]);
  });

  it("escapes ~ and / in the pointer", () => {
    expect(codes('{"a/b~":1,"a/b~":2}')).toEqual([{ code: "duplicate-key", pointer: "/a~1b~0" }]);
  });

  it("reports a repeated __proto__ or constructor like any other key", () => {
    expect(
      codes(
        '{"__proto__":{},"__proto__":null,"constructor":1,"x":{"constructor":2,"constructor":3}}',
      ),
    ).toEqual([
      { code: "duplicate-key", pointer: "/__proto__" },
      { code: "duplicate-key", pointer: "/x/constructor" },
    ]);
  });

  it("does not confuse the same key in different objects", () => {
    expect(read('{"a":{"k":1},"b":{"k":2}}').ok).toBe(true);
  });

  it("reports every duplicate and lone surrogate", () => {
    expect(codes('{"a":1,"a":2,"b":"\\ud800","c":{"d":1,"d":2}}')).toEqual([
      { code: "duplicate-key", pointer: "/a" },
      { code: "invalid-encoding", pointer: "/b" },
      { code: "duplicate-key", pointer: "/c/d" },
    ]);
  });
});
