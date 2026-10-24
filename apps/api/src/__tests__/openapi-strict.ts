/**
 * Test helper: a copy of a response schema that rejects unknown keys at
 * every depth. The published spec leaves objects open (clients must
 * ignore fields they don't know), but the contract tests want both
 * directions: a documented field the API dropped AND an undocumented
 * field the API started sending.
 *
 * Objects declared .passthrough() (the error envelope) stay open.
 */

import { z } from '../zod.js';

export function deepStrict(schema: z.ZodType): z.ZodType {
  if (schema instanceof z.ZodObject) {
    const shape = Object.fromEntries(
      Object.entries(schema.shape as Record<string, z.ZodType>).map(([k, v]) => [k, deepStrict(v)]),
    );
    const rebuilt = z.object(shape);
    // .passthrough() is a catchall of unknown in zod 4.
    return schema.def.catchall instanceof z.ZodUnknown ? rebuilt.passthrough() : rebuilt.strict();
  }
  if (schema instanceof z.ZodArray) return z.array(deepStrict(schema.element as z.ZodType));
  if (schema instanceof z.ZodOptional) return deepStrict(schema.unwrap() as z.ZodType).optional();
  if (schema instanceof z.ZodNullable) return deepStrict(schema.unwrap() as z.ZodType).nullable();
  if (schema instanceof z.ZodUnion) {
    return z.union((schema.options as z.ZodType[]).map(deepStrict) as [z.ZodType, z.ZodType, ...z.ZodType[]]);
  }
  if (schema instanceof z.ZodRecord) {
    const value = deepStrict(schema.valueType as z.ZodType);
    // An enum-keyed z.record requires every key in zod 4; keep a partialRecord partial.
    return schema.def.partial ? z.partialRecord(schema.keyType, value) : z.record(schema.keyType, value);
  }
  return schema;
}

/** Parse `value` against the strict copy of `schema`; on failure, throw
 *  with the zod issues and the value so the test output says what drifted. */
export function expectShape(schema: z.ZodType, value: unknown, label: string): void {
  const result = deepStrict(schema).safeParse(value);
  if (!result.success) {
    throw new Error(
      `${label} does not match its documented schema:\n${JSON.stringify(result.error.issues, null, 2)}\nvalue: ${JSON.stringify(value, null, 2)}`,
    );
  }
}
