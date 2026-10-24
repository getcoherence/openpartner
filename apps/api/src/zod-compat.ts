/**
 * What the API's validation looked like under zod 3, kept on zod 4.
 *
 * The API moved to zod 4 because zod 3 has no fix for GHSA-mrhx-c7xc-m3w5.
 * zod 4 rewords every default validation message and tightens
 * `.datetime()`. Both reach integrations: `detail` on an `invalid_body` /
 * `invalid_query` error is zod's flattened issues (the portal shows those
 * messages to people), and a timestamp zod 3 accepted must not start
 * coming back 400. So:
 *
 *   - zod3ErrorMap is zod's global error map: zod 3's English defaults
 *     ("Required", "Invalid email", "String must contain at least 1
 *     character(s)"). A message a schema sets itself still wins.
 *   - utcDateTime() / offsetDateTime() accept what zod 3's `.datetime()`
 *     and `.datetime({ offset: true })` did.
 *
 * Importing this module installs the error map; zod.ts does, so every
 * module that imports z from there gets it.
 */

import { z } from 'zod';

/** zod 3's ZodParsedType: the "received" in "Expected X, received Y". */
function zod3Type(data: unknown): string {
  switch (typeof data) {
    case 'undefined':
    case 'string':
    case 'boolean':
    case 'function':
    case 'bigint':
    case 'symbol':
      return typeof data;
    case 'number':
      return Number.isNaN(data) ? 'nan' : 'number';
    case 'object': {
      if (Array.isArray(data)) return 'array';
      if (data === null) return 'null';
      const thenable = data as { then?: unknown; catch?: unknown };
      if (typeof thenable.then === 'function' && typeof thenable.catch === 'function') return 'promise';
      if (data instanceof Map) return 'map';
      if (data instanceof Set) return 'set';
      if (data instanceof Date) return 'date';
      return 'object';
    }
    default:
      return 'unknown';
  }
}

/** zod 3's util.joinValues: strings quoted, joined with " | ". */
function joinValues(values: readonly unknown[], separator = ' | '): string {
  return values.map((v) => (typeof v === 'string' ? `'${v}'` : v)).join(separator);
}

/** zod 4 names a few expected types differently. */
const ZOD3_EXPECTED: Record<string, string> = { record: 'object', tuple: 'array' };

/** zod 4 splits string formats zod 3 named once. */
const ZOD3_FORMAT: Record<string, string> = { ipv4: 'ip', ipv6: 'ip', cidrv4: 'cidr', cidrv6: 'cidr' };

function schemaType(inst: unknown): string | undefined {
  return (inst as { _zod?: { def?: { type?: string } } } | undefined)?._zod?.def?.type;
}

/** zod 3's default English message for the zod 4 issue. Undefined falls
 *  through to zod 4's own message (issue kinds zod 3 never raised). */
export const zod3ErrorMap: z.core.$ZodErrorMap = (issue) => {
  switch (issue.code) {
    case 'invalid_type': {
      if (issue.input === undefined) return 'Required';
      // zod 3's z.number() let ±Infinity through (only .finite() refused
      // it); zod 4 refuses it before .int() or .finite() run.
      if (issue.expected === 'number' && typeof issue.input === 'number' && !Number.isNaN(issue.input)) {
        return 'Number must be finite';
      }
      if (issue.expected === 'int') return 'Expected integer, received float';
      return `Expected ${ZOD3_EXPECTED[issue.expected] ?? issue.expected}, received ${zod3Type(issue.input)}`;
    }
    case 'invalid_value': {
      const kind = schemaType(issue.inst);
      if (kind === 'literal') return `Invalid literal value, expected ${JSON.stringify(issue.values[0])}`;
      if (kind !== 'enum') return undefined;
      // zod 3's z.enum checked for a string first, as a type error.
      if (typeof issue.input !== 'string') {
        return issue.input === undefined ? 'Required' : `Expected ${joinValues(issue.values)}, received ${zod3Type(issue.input)}`;
      }
      return `Invalid enum value. Expected ${joinValues(issue.values)}, received '${issue.input}'`;
    }
    case 'unrecognized_keys':
      return `Unrecognized key(s) in object: ${joinValues(issue.keys, ', ')}`;
    case 'invalid_union':
      if (issue.discriminator !== undefined) {
        return `Invalid discriminator value. Expected ${joinValues((issue.options as unknown[] | undefined) ?? [])}`;
      }
      return 'Invalid input';
    case 'invalid_format':
      switch (issue.format) {
        case 'regex':
          return 'Invalid';
        case 'starts_with':
          return `Invalid input: must start with "${String(issue.prefix)}"`;
        case 'ends_with':
          return `Invalid input: must end with "${String(issue.suffix)}"`;
        case 'includes':
          return `Invalid input: must include "${String(issue.includes)}"`;
        default:
          return `Invalid ${ZOD3_FORMAT[issue.format] ?? issue.format}`;
      }
    case 'too_small': {
      const { origin, minimum, inclusive, exact } = issue;
      if (origin === 'array') return `Array must contain ${exact ? 'exactly' : inclusive ? 'at least' : 'more than'} ${minimum} element(s)`;
      if (origin === 'string') return `String must contain ${exact ? 'exactly' : inclusive ? 'at least' : 'over'} ${minimum} character(s)`;
      if (origin === 'number' || origin === 'int' || origin === 'bigint') {
        return `Number must be ${exact ? 'exactly equal to ' : inclusive ? 'greater than or equal to ' : 'greater than '}${minimum}`;
      }
      if (origin === 'date') {
        return `Date must be ${exact ? 'exactly equal to ' : inclusive ? 'greater than or equal to ' : 'greater than '}${new Date(Number(minimum))}`;
      }
      return 'Invalid input';
    }
    case 'too_big': {
      const { origin, maximum, inclusive, exact } = issue;
      if (origin === 'array') return `Array must contain ${exact ? 'exactly' : inclusive ? 'at most' : 'less than'} ${maximum} element(s)`;
      if (origin === 'string') return `String must contain ${exact ? 'exactly' : inclusive ? 'at most' : 'under'} ${maximum} character(s)`;
      if (origin === 'number' || origin === 'int') {
        return `Number must be ${exact ? 'exactly' : inclusive ? 'less than or equal to' : 'less than'} ${maximum}`;
      }
      if (origin === 'bigint') return `BigInt must be ${exact ? 'exactly' : inclusive ? 'less than or equal to' : 'less than'} ${maximum}`;
      if (origin === 'date') {
        return `Date must be ${exact ? 'exactly' : inclusive ? 'smaller than or equal to' : 'smaller than'} ${new Date(Number(maximum))}`;
      }
      return 'Invalid input';
    }
    case 'not_multiple_of':
      return `Number must be a multiple of ${issue.divisor}`;
    case 'custom':
      return 'Invalid input';
    default:
      return undefined;
  }
};

z.config({ customError: zod3ErrorMap });

// zod 3's datetimeRegex. zod 4 requires seconds ("2026-10-16T10:00Z" was a
// valid zod 3 timestamp) and only a +HH:MM offset (zod 3 took +HHMM too).
const DATE = String.raw`((\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00)-02-29|\d{4}-((0[13578]|1[02])-(0[1-9]|[12]\d|3[01])|(0[469]|11)-(0[1-9]|[12]\d|30)|(02)-(0[1-9]|1\d|2[0-8])))`;
const TIME = String.raw`([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d+)?)?`;
const UTC_DATETIME = new RegExp(`^${DATE}T${TIME}(Z)$`);
const OFFSET_DATETIME = new RegExp(String.raw`^${DATE}T${TIME}(Z|([+-]\d{2}:?\d{2}))$`);

/** An ISO 8601 timestamp in UTC, ending in Z, seconds optional. Documented
 *  as `format: date-time`; refused with zod 3's "Invalid datetime". */
export function utcDateTime() {
  return z.stringFormat('datetime', UTC_DATETIME);
}

/** utcDateTime(), or with a ±HH:MM / ±HHMM offset instead of Z. */
export function offsetDateTime() {
  return z.stringFormat('datetime', OFFSET_DATETIME);
}
