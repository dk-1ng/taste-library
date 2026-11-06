import { z } from "zod";

/**
 * A version 1 file schema with `formatVersion` 2 instead of 1, and everything else unchanged: its
 * strictness, its refinements, and its key order, so `formatVersion` stays the first key (zod
 * keeps the position of a key it overwrites). `safeExtend` is zod's `extend` for a schema with
 * refinements (`extend` refuses to overwrite a key there). Its types allow only narrowing a key,
 * which 2 does not do to 1, so the schema is taken as an object schema of any shape.
 */
export function atVersion2<T extends z.ZodObject<z.core.$ZodLooseShape, z.core.$strict>>(
  schema: T,
): z.ZodType {
  return (schema as z.ZodObject<z.core.$ZodLooseShape, z.core.$strict>).safeExtend({
    formatVersion: z.literal(2),
  });
}

/** The same, with fields added after the others (for data a step moves into the file). */
export function atVersion2With<T extends z.ZodObject<z.core.$ZodLooseShape, z.core.$strict>>(
  schema: T,
  added: z.core.$ZodLooseShape,
): z.ZodType {
  return (schema as z.ZodObject<z.core.$ZodLooseShape, z.core.$strict>).safeExtend({
    formatVersion: z.literal(2),
    ...added,
  });
}
