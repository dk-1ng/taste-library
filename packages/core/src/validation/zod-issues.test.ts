import { describe, expect, it } from "vitest";
import { z } from "zod";
import { addRuleIssue } from "../schemas/v1/shared.js";
import { describePath, issuesFromZod, pointerOf } from "./zod-issues.js";

function run(schema: z.ZodType, value: unknown) {
  const result = schema.safeParse(value, { reportInput: true });
  if (result.success) throw new Error("expected a failure");
  return issuesFromZod(result.error, "references/x.json");
}

describe("describePath and pointerOf", () => {
  it("writes paths like pins[0].region.w", () => {
    expect(describePath(["pins", 0, "region", "w"])).toBe("pins[0].region.w");
    expect(describePath([])).toBe("the file");
    expect(describePath(["a b", "c"])).toBe('["a b"].c');
  });
  it("escapes JSON Pointer tokens", () => {
    expect(pointerOf(["pins", 0, "region", "w"])).toBe("/pins/0/region/w");
    expect(pointerOf(["a/b", "c~d"])).toBe("/a~1b/c~0d");
    expect(pointerOf([])).toBeNull();
  });
});

describe("issuesFromZod", () => {
  it("gives every issue the severity of its code, the file and an English message", () => {
    const issues = run(z.strictObject({ n: z.number().gt(0) }), { n: 0 });
    expect(issues).toEqual([
      {
        severity: "error",
        code: "schema-violation",
        file: "references/x.json",
        pointer: "/n",
        message: "n: must be greater than 0.",
      },
    ]);
  });

  it("reports an unknown field once per field, pointing at the field", () => {
    const issues = run(z.strictObject({ a: z.string() }), { a: "x", b: 1, c: 2 });
    expect(issues.map((i) => i.pointer)).toEqual(["/b", "/c"]);
  });

  it("tells a missing field from a wrong type", () => {
    const issues = run(z.strictObject({ a: z.string(), b: z.string() }), { b: 3 });
    expect(issues.map((i) => i.message)).toEqual(["a: is required.", "b: must be a string."]);
  });

  it("describes enums, literals, array counts and discriminators", () => {
    expect(run(z.enum(["a", "b"]), "c")[0]?.message).toBe('the file: must be one of "a", "b".');
    expect(run(z.literal(1), 2)[0]?.message).toBe("the file: must be 1.");
    expect(run(z.array(z.string()).max(1), ["a", "b"])[0]?.message).toBe(
      "the file: must have at most 1 item.",
    );
    expect(run(z.array(z.string()).min(2), ["a"])[0]?.message).toBe(
      "the file: must have at least 2 items.",
    );
    const union = z.discriminatedUnion("k", [
      z.strictObject({ k: z.literal("x") }),
      z.strictObject({ k: z.literal("y") }),
    ]);
    expect(run(union, {})[0]?.message).toBe("k: is required.");
    expect(run(union, { k: "z" })[0]?.message).toBe('k: must be one of "x", "y".');
  });

  it("uses the code a custom issue carries and schema-violation otherwise", () => {
    const schema = z.unknown().superRefine((_value, ctx) => {
      addRuleIssue(ctx, ["a"], "twice.", "duplicate-id");
      addRuleIssue(ctx, ["b"], "nowhere.", "broken-local-link");
      addRuleIssue(ctx, ["c"], "plain.");
    });
    expect(run(schema, {}).map((i) => i.code)).toEqual([
      "duplicate-id",
      "broken-local-link",
      "schema-violation",
    ]);
  });

  it("does not report the same issue twice", () => {
    const schema = z.unknown().superRefine((_value, ctx) => {
      addRuleIssue(ctx, ["a"], "same.");
      addRuleIssue(ctx, ["a"], "same.");
    });
    expect(run(schema, {})).toHaveLength(1);
  });

  it("names keys that are not plain identifiers in the message and escapes them in the pointer", () => {
    const issues = run(z.record(z.string(), z.number()), { "a/b": "x" });
    expect(issues[0]).toMatchObject({ pointer: "/a~1b", message: '["a/b"]: must be a number.' });
  });
});
