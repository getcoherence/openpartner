/**
 * Test helper: a copy of a response schema that rejects unknown keys at
 * every depth. The published spec leaves objects open (clients must
 * ignore fields they don't know), but the contract tests want both
 * directions: a documented field the API dropped AND an undocumented
 * field the API started sending.
 *
 * Objects declared .passthrough() (the error envelope) stay open.
 */

import { z, type ZodTypeAny } from 'zod';

export function deepStrict(schema: ZodTypeAny): ZodTypeAny {
  if (schema instanceof z.ZodObject) {
    const shape = Object.fromEntries(
      Object.entries(schema.shape as Record<string, ZodTypeAny>).map(([k, v]) => [k, deepStrict(v)]),
    );
    const rebuilt = z.object(shape);
    return schema._def.unknownKeys === 'passthrough' ? rebuilt.passthrough() : rebuilt.strict();
  }
  if (schema instanceof z.ZodArray) return z.array(deepStrict(schema.element));
  if (schema instanceof z.ZodOptional) return deepStrict(schema.unwrap()).optional();
  if (schema instanceof z.ZodNullable) return deepStrict(schema.unwrap()).nullable();
  if (schema instanceof z.ZodUnion) {
    return z.union((schema.options as ZodTypeAny[]).map(deepStrict) as [ZodTypeAny, ZodTypeAny, ...ZodTypeAny[]]);
  }
  if (schema instanceof z.ZodRecord) return z.record(schema.keySchema, deepStrict(schema.valueSchema));
  return schema;
}

/** Parse `value` against the strict copy of `schema`; on failure, throw
 *  with the zod issues and the value so the test output says what drifted. */
export function expectShape(schema: ZodTypeAny, value: unknown, label: string): void {
  const result = deepStrict(schema).safeParse(value);
  if (!result.success) {
    throw new Error(
      `${label} does not match its documented schema:\n${JSON.stringify(result.error.issues, null, 2)}\nvalue: ${JSON.stringify(value, null, 2)}`,
    );
  }
}
