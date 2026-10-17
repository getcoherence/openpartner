/**
 * Keyset pagination over (timestamp DESC, id DESC) — the ordering every
 * history list in the API uses (GET /partners, GET /commissions).
 *
 * Cursors are opaque base64url(`<timestamp>|<id>`) so callers don't try
 * to construct them and we keep the ordering invariant server-side.
 *
 * The timestamp is carried at Postgres's full MICROSECOND precision,
 * read back from the row via `cursorTimestamp()`. Encoding a JS Date
 * (millisecond precision) silently dropped rows: every Partner a CSV
 * import inserts shares one `now()` — the request transaction's — so a
 * cursor of `…:00.123Z` matched neither `< ts` nor `= ts` for the batch's
 * `…:00.123456` rows, and page 2 skipped the rest of the import. The same
 * holds for Commission rows accrued in one transaction.
 *
 * Cursors minted before this (millisecond ISO strings) still decode.
 */

import type { Knex } from 'knex';

export interface KeysetCursor {
  /** UTC ISO-8601, up to microsecond precision. */
  ts: string;
  id: string;
}

const CURSOR_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;

/** Column alias the page query selects the cursor timestamp under. */
export const CURSOR_TS_ALIAS = '_cursorTs';

/** SELECT expression rendering `column` (a timestamptz) as UTC ISO-8601
 *  with microseconds, aliased to CURSOR_TS_ALIAS. */
export function cursorTimestamp(db: Knex, column: string): Knex.Raw {
  return db.raw(`to_char(?? at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as ??`, [
    column,
    CURSOR_TS_ALIAS,
  ]);
}

export function encodeCursor(c: KeysetCursor): string {
  return Buffer.from(`${c.ts}|${c.id}`).toString('base64url');
}

export function decodeCursor(cursor: string): KeysetCursor | null {
  const raw = Buffer.from(cursor, 'base64url').toString('utf8');
  const sep = raw.indexOf('|');
  if (sep < 0) return null;
  const ts = raw.slice(0, sep);
  const id = raw.slice(sep + 1);
  if (!CURSOR_TS.test(ts) || !id) return null;
  return { ts, id };
}

/** Restrict `qb` to rows strictly after the cursor in (ts DESC, id DESC)
 *  order — the row at the cursor itself was the previous page's last. */
export function whereAfterCursor<Q extends Knex.QueryBuilder>(
  qb: Q,
  tsColumn: string,
  idColumn: string,
  cursor: KeysetCursor,
): Q {
  return qb.whereRaw('(??, ??) < (?::timestamptz, ?)', [tsColumn, idColumn, cursor.ts, cursor.id]) as Q;
}

/** Split a `limit + 1` fetch into the page and the next cursor (null
 *  when there are no more rows), stripping the cursor column. */
export function takePage<R extends { id: string; [CURSOR_TS_ALIAS]: string }>(
  rows: R[],
  limit: number,
): { page: Array<Omit<R, typeof CURSOR_TS_ALIAS>>; nextCursor: string | null } {
  const hasMore = rows.length > limit;
  const kept = hasMore ? rows.slice(0, limit) : rows;
  const last = kept[kept.length - 1];
  const nextCursor = hasMore && last ? encodeCursor({ ts: last[CURSOR_TS_ALIAS], id: last.id }) : null;
  const page = kept.map(({ [CURSOR_TS_ALIAS]: _ts, ...rest }) => rest);
  return { page, nextCursor };
}
