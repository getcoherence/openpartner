/**
 * Export / import — data portability primitives.
 *
 * Architectural commitment (CLAUDE.md): the JSON and SQL exports from the
 * hosted version must re-import cleanly into the self-hosted version. (CSV
 * is a VIEW, not a restore format — it has no type or ordering fidelity.)
 * The table set is deliberately explicit, and what's missing from it is
 * listed in docs/data-portability.md rather than left to be discovered.
 * That means:
 *   1. The list of tables is stable across versions (additions OK, removals
 *      need a migration path).
 *   2. Column shapes are the raw DB row shape. Derived state gets re-derived
 *      post-import if needed.
 *   3. Sidecar / hosted-only metadata lives in clearly-labeled columns (none
 *      yet; this is the enforcement point when we add them).
 *
 * The exportable tables are listed here explicitly — don't infer from the DB,
 * because that would silently start exporting future hosted-only sidecar
 * tables we haven't yet designed for round-trip.
 */

import type { Knex } from 'knex';
import { DEFAULT_TENANT_ID, TABLES } from '@openpartner/db';

/** Bundle format version. Bumped when the table set or row shape changes.
 *  v1 → v2 (Aug 2026): added PartnerProgram, PartnerCommission, Coupon;
 *  every table now carries its real primary key instead of assuming `id`. */
export const SCHEMA_VERSION = 2;
/** Older bundles still import — a v1 bundle is a v2 bundle minus three
 *  tables. Dropping support for a version people hold on disk would break
 *  the portability promise, so this list only ever grows. */
export const SUPPORTED_IMPORT_VERSIONS = [1, 2] as const;

export interface ExportTableSpec {
  table: string;
  /** Conflict target for idempotent re-import. NOT always `id` —
   *  PartnerCommission is keyed on partnerId (one snapshot per partner). */
  primaryKey: string;
}

/**
 * The exportable set, in FK-safe import order (parents first).
 *
 * Order is load-bearing: `importBundle` walks it as written, so a table
 * must appear after everything it references.
 */
export const EXPORT_TABLES = [
  { table: TABLES.Partner, primaryKey: 'id' },
  { table: TABLES.Program, primaryKey: 'id' },
  // Which partners may promote which programs. Without this the roster
  // survives an export but every grant is lost, so an imported instance
  // silently shows partners with no programs.
  { table: TABLES.PartnerProgram, primaryKey: 'id' },
  // Snapshotted per-partner commission rules — the terms a partnership was
  // agreed on. Keyed on partnerId, one row per partner.
  { table: TABLES.PartnerCommission, primaryKey: 'partnerId' },
  // Coupon-code attribution. A coupon-driven conversion can't be
  // re-derived without the code → (partner, program) mapping.
  { table: TABLES.Coupon, primaryKey: 'id' },
  { table: TABLES.Link, primaryKey: 'id' },
  { table: TABLES.Click, primaryKey: 'id' },
  { table: TABLES.Identity, primaryKey: 'id' },
  { table: TABLES.Event, primaryKey: 'id' },
  { table: TABLES.Attribution, primaryKey: 'id' },
  { table: TABLES.Commission, primaryKey: 'id' },
  { table: TABLES.Payout, primaryKey: 'id' },
  // Sidecar (hosted white-label custom domains). Exported losslessly;
  // edge/billing semantics are inert on self-hosted import — the rows are
  // domain history, and a self-hosted instance derives its own edge.
  { table: TABLES.PortalCustomDomain, primaryKey: 'id' },
  // Core compensating-entry ledger (clawbacks/corrections against paid
  // commissions). Ordered after Commission for FK-safe import.
  { table: TABLES.CommissionAdjustment, primaryKey: 'id' },
] as const satisfies readonly ExportTableSpec[];

export type ExportableTable = (typeof EXPORT_TABLES)[number]['table'];

export const EXPORTABLE_TABLES = EXPORT_TABLES.map((s) => s.table) as readonly ExportableTable[];

// Import order respects FK dependencies: parents first.
export const IMPORT_ORDER = EXPORT_TABLES;

export function primaryKeyOf(table: string): string {
  return EXPORT_TABLES.find((s) => s.table === table)?.primaryKey ?? 'id';
}

export function isExportable(name: string): name is ExportableTable {
  return (EXPORTABLE_TABLES as readonly string[]).includes(name);
}

export async function exportTable(db: Knex, table: ExportableTable): Promise<unknown[]> {
  return db(table).select('*');
}

/**
 * column → Postgres type, per table, read from the live schema.
 *
 * Needed because a JS array coming back from `select *` is ambiguous: it
 * could be a `jsonb` array (`Program.commissionRule`) or a real Postgres
 * array (`Program.categories` is `text[]`). Guessing gets one of them
 * wrong on re-import — which is precisely how compound commission rules
 * used to fail to restore.
 */
export type ColumnTypeMap = Record<string, Record<string, string>>;

export async function tableColumnTypes(db: Knex, table: string): Promise<Record<string, string>> {
  const info = (await db(table).columnInfo()) as Record<string, { type: string }>;
  return Object.fromEntries(Object.entries(info).map(([col, meta]) => [col, meta.type]));
}

export async function exportColumnTypes(db: Knex): Promise<ColumnTypeMap> {
  const out: ColumnTypeMap = {};
  for (const { table } of EXPORT_TABLES) {
    out[table] = await tableColumnTypes(db, table);
  }
  return out;
}

function isJsonType(type: string | undefined): boolean {
  return type === 'json' || type === 'jsonb';
}

function isTimestampType(type: string | undefined): boolean {
  return (
    type === 'timestamp with time zone' ||
    type === 'timestamp without time zone' ||
    type === 'timestamptz' ||
    type === 'timestamp' ||
    type === 'date'
  );
}

export async function exportAll(db: Knex): Promise<Record<string, unknown[]>> {
  const out: Record<string, unknown[]> = {};
  for (const { table } of EXPORT_TABLES) {
    out[table] = await exportTable(db, table as ExportableTable);
  }
  return out;
}

export function rowsToCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return '';
  const columns = Array.from(new Set(rows.flatMap((r) => Object.keys(r))));
  const header = columns.map(csvEscape).join(',');
  const body = rows.map((row) => columns.map((c) => csvEscape(formatCell(row[c]))).join(','));
  return [header, ...body].join('\n');
}

function formatCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function csvEscape(v: string): string {
  // Formula-injection guard: Excel / Google Sheets / Numbers will
  // evaluate a cell that starts with =, +, -, or @ as a formula, which
  // can exfiltrate data or run external calls (=HYPERLINK, =IMPORTXML).
  // Prefix with a single quote, which all three strip on display. We
  // do this before the quote-wrap test so the final cell is still a
  // valid CSV value.
  const needsFormulaGuard = /^[=+\-@\t\r]/.test(v);
  const safe = needsFormulaGuard ? `'${v}` : v;
  if (/[",\n\r]/.test(safe)) return `"${safe.replace(/"/g, '""')}"`;
  return safe;
}

// ---------------------------------------------------------------------------
// SQL dump — the third promised format (CLAUDE.md principle #2)
// ---------------------------------------------------------------------------

export interface SqlDumpOptions {
  /**
   * Bake this tenant id into every row. Omit for the PORTABLE form, which
   * emits `:'tenant_id'` and a psql `\set` fallback so one file restores
   * into any instance:
   *
   *   psql "$DATABASE_URL" -v tenant_id=<destination tenant id> -f openpartner-export.sql
   *
   * Baking a literal produces plain SQL any client can run — used when the
   * caller already knows the destination.
   */
  tenantId?: string;
  /** Recorded in the header comment. */
  exportedAt?: string;
  sourceTenantId?: string;
  /** Rows per INSERT statement. Keeps statements parseable by editors and
   *  bounded in memory on restore. */
  chunkSize?: number;
  /** Live column types (see `exportColumnTypes`). Without them a JS array
   *  is rendered as JSON, which is wrong for `text[]` columns. */
  columnTypes?: ColumnTypeMap;
}

/** psql substitutes this before the server ever sees it. */
const TENANT_PLACEHOLDER = ":'tenant_id'";

/**
 * Tenant ids are ULIDs we generate. Anything else is refused rather than
 * escaped.
 *
 * In portable mode the `\set` line carries a constant, so the risk is the
 * literal mode: the value is written into a `--` header comment, and the
 * file it lands in is executed by psql, whose meta-commands are
 * line-oriented. A newline would end the comment and start a line the
 * restoring machine obeys. Validation is the guard; `commentSafe` below
 * is the belt to its braces.
 */
export function isSafeTenantId(tenantId: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(tenantId);
}

export function assertSafeTenantId(tenantId: string): void {
  if (!isSafeTenantId(tenantId)) throw new Error('invalid tenant id');
}

/** Defence in depth for the header lines: never let a value break out of
 *  its comment, even one that should already be safe. */
function commentSafe(v: string): string {
  return v.replace(/[\r\n]+/g, ' ').slice(0, 200);
}

/**
 * Render a bundle as a re-importable SQL dump.
 *
 * Every statement is `ON CONFLICT (pk) DO NOTHING`, so a restore is
 * idempotent and a partial-then-resumed restore works — the same
 * guarantee `importBundle` gives the JSON path. Tables are emitted in
 * IMPORT_ORDER so foreign keys resolve as the file is read top to bottom.
 */
export function buildSqlDump(bundle: ImportBundle, opts: SqlDumpOptions = {}): string {
  const chunkSize = opts.chunkSize ?? 500;
  if (opts.tenantId !== undefined) assertSafeTenantId(opts.tenantId);
  const tenantExpr = opts.tenantId === undefined ? TENANT_PLACEHOLDER : sqlLiteral(opts.tenantId);
  const out: string[] = [];

  out.push(`-- OpenPartner export — schemaVersion ${SCHEMA_VERSION}`);
  // Only ever comment values that cannot contain a newline. A comment is
  // NOT a safe place for arbitrary text: one embedded newline ends the
  // comment, and a line starting with a backslash is a psql meta-command
  // (`\!` runs a shell command on the machine doing the restore).
  out.push(`-- exported ${commentSafe(opts.exportedAt ?? new Date().toISOString())}${opts.sourceTenantId ? ` from tenant ${commentSafe(opts.sourceTenantId)}` : ''}`);
  out.push('--');
  if (opts.tenantId === undefined) {
    out.push('-- Restore into a self-hosted instance:');
    out.push(`--   psql "$DATABASE_URL" -v tenant_id=${DEFAULT_TENANT_ID} -f openpartner-export.sql`);
    out.push('--');
    out.push('-- Every row is inserted under :tenant_id, so this file restores into any');
    out.push('-- tenant. Re-running it is safe: every statement is ON CONFLICT DO NOTHING.');
  } else {
    out.push(`-- Rows are pinned to tenant ${commentSafe(opts.tenantId)}. Re-running is safe:`);
    out.push('-- every statement is ON CONFLICT DO NOTHING.');
  }
  out.push('');
  if (opts.tenantId === undefined) {
    // psql meta-commands, stripped by nothing else — they never reach the
    // server. Default to the self-host tenant when -v wasn't passed. This
    // is the tenant's PRIMARY KEY, not its slug: rows carry `tenantId`,
    // which is a foreign key to Tenant.id, so 'default' would fail the FK.
    out.push('\\if :{?tenant_id}');
    out.push('\\else');
    out.push(`\\set tenant_id '${DEFAULT_TENANT_ID}'`);
    out.push('\\endif');
    out.push('');
  }
  out.push('BEGIN;');
  // Pin the string-literal mode the escaping in sqlLiteral() assumes. On
  // by default since PG 9.1, but a server with it OFF would treat a
  // backslash in exported data as an escape and let a crafted value break
  // out of its literal — so the dump states the assumption instead of
  // trusting it.
  out.push('SET LOCAL standard_conforming_strings = on;');
  // Makes the restore work on the RLS-scoped app role too, not just the
  // privileged migration role: the policies read this GUC.
  out.push(`SELECT set_config('app.tenant_id', ${tenantExpr}, true);`);
  out.push('');

  for (const { table, primaryKey } of EXPORT_TABLES) {
    const rows = (bundle[table] ?? []) as Record<string, unknown>[];
    if (rows.length === 0) {
      out.push(`-- ${table}: no rows`);
      out.push('');
      continue;
    }
    const types = opts.columnTypes?.[table] ?? {};
    const columns = Array.from(new Set(rows.flatMap((r) => Object.keys(r))));
    const columnList = columns.map(quoteIdent).join(', ');
    out.push(`-- ${table} (${rows.length} row${rows.length === 1 ? '' : 's'})`);
    for (let i = 0; i < rows.length; i += chunkSize) {
      const chunk = rows.slice(i, i + chunkSize);
      const values = chunk.map(
        (row) =>
          `  (${columns
            .map((c) => (c === 'tenantId' ? tenantExpr : sqlLiteral(row[c], types[c])))
            .join(', ')})`,
      );
      out.push(`INSERT INTO ${quoteIdent(table)} (${columnList}) VALUES`);
      out.push(values.join(',\n'));
      out.push(`ON CONFLICT (${quoteIdent(primaryKey)}) DO NOTHING;`);
    }
    out.push('');
  }

  out.push('COMMIT;');
  out.push('');
  return out.join('\n');
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * A Postgres literal for a value that came back from `select *`.
 *
 * Composite values are emitted as UNTYPED string literals and left for
 * Postgres to coerce to the destination column — that is how pg_dump
 * handles numerics, timestamps, json and arrays, and it means the dump
 * doesn't have to name types it can't always know. `pgType` only has to
 * disambiguate one thing: a JS array is a Postgres array for `text[]` and
 * a JSON array for `jsonb`.
 */
function sqlLiteral(v: unknown, pgType?: string): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  if (typeof v === 'bigint') return String(v);
  if (v instanceof Date) return `'${v.toISOString()}'`;
  if (Buffer.isBuffer(v)) return `'\\x${v.toString('hex')}'::bytea`;
  if (Array.isArray(v) && pgType === 'ARRAY') return escapeString(pgArrayLiteral(v));
  if (typeof v === 'object') return escapeString(JSON.stringify(v));
  return escapeString(String(v));
}

/** `{"a","b"}` — the element-type-agnostic array literal, so the same
 *  renderer works for text[], int[] and anything else. */
function pgArrayLiteral(values: unknown[]): string {
  const parts = values.map((el) => {
    if (el === null || el === undefined) return 'NULL';
    const s = typeof el === 'object' ? JSON.stringify(el) : String(el);
    return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  });
  return `{${parts.join(',')}}`;
}

function escapeString(s: string): string {
  // standard_conforming_strings has been on by default since PG 9.1, so a
  // backslash is a literal backslash and only the quote needs doubling.
  return `'${s.replace(/'/g, "''")}'`;
}

export interface ImportBundle {
  [table: string]: unknown[];
}

export interface ImportReport {
  inserted: Record<string, number>;
  skipped: Record<string, number>;
}

/**
 * Re-import a bundle. We use onConflict(pk).ignore so the operation is
 * idempotent: running the same export twice won't create duplicates, and
 * partial-then-resumed imports work.
 *
 * Multi-tenant: every row's tenantId is rewritten to the importing tenant.
 * This is what lets a hosted-tier export ("acme" tenantId throughout)
 * round-trip into a self-host installation (default tenantId), satisfying
 * the data-portability commitment in CLAUDE.md.
 */
export async function importBundle(
  db: Knex,
  tenantId: string,
  bundle: ImportBundle,
): Promise<ImportReport> {
  const inserted: Record<string, number> = {};
  const skipped: Record<string, number> = {};

  for (const { table, primaryKey } of IMPORT_ORDER) {
    const rows = bundle[table];
    if (!Array.isArray(rows) || rows.length === 0) continue;

    // Read the destination's column types once per table. Without this a
    // JSON array (Program.commissionRule) is handed to the driver as a
    // Postgres array literal and the whole import fails.
    const types = await tableColumnTypes(db, table);
    const normalized = rows.map((r) => ({
      ...normalizeRow(r as Record<string, unknown>, types),
      tenantId,
    }));

    // The conflict target has to be the table's REAL primary key —
    // assuming `id` silently broke every table keyed on something else
    // (PartnerCommission is keyed on partnerId).
    const result = await db(table)
      .insert(normalized)
      .onConflict(primaryKey)
      .ignore()
      .returning(primaryKey);

    inserted[table] = result.length;
    skipped[table] = rows.length - result.length;
  }

  return { inserted, skipped };
}

function normalizeRow(
  row: Record<string, unknown>,
  types: Record<string, string> = {},
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    // Only revive a string as a Date when the COLUMN is a timestamp.
    // Matching on shape alone corrupted ordinary text that happens to look
    // like one — a partner named "2026-08-09T00:00:00", a userId, a coupon
    // code — and could fail the import outright on a lookalike that isn't
    // a valid date.
    if (typeof v === 'string' && isTimestampType(types[k]) && isIsoDate(v)) {
      out[k] = new Date(v);
    } else if (isJsonType(types[k]) && v !== null && typeof v === 'object') {
      // Serialize json/jsonb ourselves. The driver renders a bare JS array
      // as a Postgres array literal, which a json column rejects.
      out[k] = JSON.stringify(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function isIsoDate(v: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(v);
}
