/**
 * Export / import — data portability primitives.
 *
 * Architectural commitment (CLAUDE.md): any export from the hosted version
 * must re-import cleanly into the self-hosted version. That means:
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
import { TABLES } from '@openpartner/db';

export const EXPORTABLE_TABLES = [
  TABLES.Partner,
  TABLES.Program,
  TABLES.Link,
  TABLES.Click,
  TABLES.Identity,
  TABLES.Event,
  TABLES.Attribution,
  TABLES.Commission,
  TABLES.Payout,
  // Sidecar (hosted white-label custom domains). Exported losslessly;
  // edge/billing semantics are inert on self-hosted import — the rows are
  // domain history, and a self-hosted instance derives its own edge.
  TABLES.PortalCustomDomain,
] as const;

export type ExportableTable = (typeof EXPORTABLE_TABLES)[number];

// Import order respects FK dependencies: parents first.
export const IMPORT_ORDER = EXPORTABLE_TABLES;

export function isExportable(name: string): name is ExportableTable {
  return (EXPORTABLE_TABLES as readonly string[]).includes(name);
}

export async function exportTable(db: Knex, table: ExportableTable): Promise<unknown[]> {
  return db(table).select('*');
}

export async function exportAll(db: Knex): Promise<Record<string, unknown[]>> {
  const out: Record<string, unknown[]> = {};
  for (const table of EXPORTABLE_TABLES) {
    out[table] = await exportTable(db, table);
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

  for (const table of IMPORT_ORDER) {
    const rows = bundle[table];
    if (!Array.isArray(rows) || rows.length === 0) continue;

    const normalized = rows.map((r) => ({
      ...normalizeRow(r as Record<string, unknown>),
      tenantId,
    }));

    const result = await db(table)
      .insert(normalized)
      .onConflict('id')
      .ignore()
      .returning('id');

    inserted[table] = result.length;
    skipped[table] = rows.length - result.length;
  }

  return { inserted, skipped };
}

function normalizeRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (typeof v === 'string' && isIsoDate(v)) {
      out[k] = new Date(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function isIsoDate(v: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(v);
}
