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

import { createHash, randomBytes } from 'node:crypto';
import type { Knex } from 'knex';
import { DEFAULT_TENANT_ID, TABLES } from '@openpartner/db';
import { mintSecret } from './webhook-secret.js';
import { openForExport, sealForImport } from './payout-profile.js';
import { openPostbackForExport, sealPostbackForImport } from './postback-url.js';

/** Bundle format version. Bumped when the table set or row shape changes.
 *  v1 → v2 (Aug 2026): added PartnerProgram, PartnerCommission, Coupon;
 *  every table now carries its real primary key instead of assuming `id`.
 *  v2 → v3 (Oct 2026): PartnerCommission rows carry `id` (the new primary
 *  key) and `programId` (null = partner-wide, set = one program).
 *  v3 → v4 (Oct 2026): added PartnerNetworkConsent.
 *  v4 → v5 (Oct 2026): added BrandAsset, WebhookEndpoint, PartnerPostback,
 *  ConversionPostbackToken and Config — the last three tables' credentials
 *  stay out (see CredentialSpec), and Config only for PORTABLE_CONFIG_KEYS.
 *  Program rows carry `renewalsStayWithPartner`, and Partner rows carry
 *  `portalAccess`.
 *  v5 → v6 (Oct 2026): added Bonus. Commission rows carry `bonusId` (set on
 *  a bonus's commission, whose `attributionId` is then null).
 *  v6 → v7 (Oct 2026): added Bounty (performance bounties; Bonus.bountyId
 *  references it).
 *  v7 → v8 (Oct 2026): Click rows carry `subId` (the publisher's `?sub_id=`
 *  off the partner link).
 *  v8 → v9 (Oct 2026): added PartnerPayoutProfile (where each partner wants
 *  manual payouts sent), its `details` opened (see SealedSpec).
 *  v9 → v10 (Oct 2026): Coupon rows carry `brandChosen` (the brand's admin
 *  typed the code; the Stripe webhook credits a promo the brand already had
 *  under it only then). */
export const SCHEMA_VERSION = 10;
/** Older bundles still import — a v1 bundle is a v2 bundle minus three
 *  tables, a v2 bundle's PartnerCommission rows are partner-wide v3 rows
 *  (see upgradeBundle), a v3 bundle is a v4 bundle minus
 *  PartnerNetworkConsent, and a v4 bundle is a v5 bundle minus the five
 *  tables v5 added, whose rows take the new columns' defaults: a Program
 *  row without `renewalsStayWithPartner` gets true (the value the migration
 *  gave every existing program), and a Partner row without `portalAccess`
 *  gets true (every partner had portal access before the column existed).
 *  A v5 bundle is a v6 bundle with no bonuses: its Commission rows all have
 *  an attributionId, and `bonusId` takes its default (null). A v6 bundle is
 *  a v7 bundle with no bounties: none of its bonuses name one. A v7 bundle's
 *  Click rows have no `subId`, so it takes its default (null): no click
 *  carried one before the column existed. A v8 bundle is a v9 bundle with no
 *  payout details: every restored partner starts without any. A v9 bundle's
 *  Coupon rows have no `brandChosen`, so it takes its default (false), the
 *  value the migration gave every existing code.
 *  Dropping support for a version people hold on disk would break the
 *  portability promise, so this list only ever grows. */
export const SUPPORTED_IMPORT_VERSIONS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;

/**
 * The Config keys that travel: the brand's own program and portal settings.
 * Every other key is a credential, hosted/platform operational state, or
 * bookkeeping a fresh instance rebuilds — listed with the reason in
 * docs/data-portability.md. Applied on import too, so a bundle can't carry
 * a key the exporter would never write.
 */
export const PORTABLE_CONFIG_KEYS = [
  // Program name, support email, router URL, whether partners see the
  // Network (routes/settings.ts ProgramSettings).
  'program_settings',
  // The join page: auto-approve vs review, or closed.
  'partner_signup',
  // Whether partners created without an invite get portal access
  // (partner-portal-access.ts). A headless program keeps its customers out
  // of the portal, and a restored instance must keep doing so.
  'partner_access',
  // "Not now" to the Network listing on the Getting started card
  // (onboarding-settings.ts). A key, not a table or column, so no version
  // bump: an instance that predates it skips the key on import, and the
  // brand just sees the Network step again.
  'onboarding',
  // What payout statements print: legal name, address, footer, number
  // prefix, the tax-lines stub (payout-statements.ts). No version bump,
  // as for 'onboarding': an older instance skips it and prints statements
  // under the brand name until the settings are entered again.
  'payout_statements',
  // "Pay balances PayPal can't send in: USD" (paypal-send-as.ts). A brand
  // setting with no credential in it (the PayPal app never travels). Added
  // without a version bump, like `onboarding`: an instance that predates it
  // skips the key, and the setting reads as off.
  'paypal_payouts',
  // Which event types partners see as referral stages, and whether they
  // see customer labels (referrals.ts). A key, so no version bump: an
  // instance that predates it skips the key, and partners see the default
  // stages and no labels, which shows them less, never more.
  'partner_referrals',
] as const;

/**
 * Credential columns. Never written to any export format, so a bundle on
 * someone's disk can't sign a webhook or record a conversion. A NOT NULL
 * column can't just be left empty on restore, so the importer puts a fresh
 * value in its place.
 */
export interface CredentialSpec {
  /** Dropped from every export (JSON, CSV, SQL); ignored if a bundle has them. */
  omit: readonly string[];
  /** JSON import: values for one restored row (`omit` and anything derived
   *  from it). `reveal` is handed back once to the admin who ran the import
   *  — the only time the API shows that secret, which it stores sealed. */
  fresh: (row: Record<string, unknown>) => { values: Record<string, unknown>; reveal?: Record<string, unknown> };
  /** SQL dump: column → expression the restoring Postgres evaluates per row. */
  sql: Record<string, string>;
  /** SQL dump: statements after the table's inserts, given the tenant expression. */
  sqlAfter?: (tenantExpr: string) => string[];
}

/**
 * Columns stored sealed under this deployment's SECRETS_ENCRYPTION_KEY. A
 * sealed value means nothing anywhere else, so it travels opened: `open`
 * runs for every export format, and the JSON import runs `seal` to seal it
 * again under the destination's key. A SQL restore can't encrypt (the key
 * is the app's), so it writes the opened value, and the API seals it: a
 * sweep at startup and hourly, and for payout details also the first read.
 * Not credentials: the data is the brand's and its partners', and leaving
 * it out would strand it on this deployment.
 */
export interface SealedSpec {
  open: (row: Record<string, unknown>) => Record<string, unknown>;
  seal: (row: Record<string, unknown>) => Record<string, unknown>;
}

export interface ExportTableSpec {
  table: string;
  /** The table's real primary key. NOT always `id` in general, so it's
   *  looked up per table rather than assumed. */
  primaryKey: string;
  /** What a re-imported row may collide on. 'primaryKey' (the default)
   *  makes the primary key the ON CONFLICT target. 'any' skips a row that
   *  collides with ANY unique constraint — for tables whose natural key is
   *  a separate unique index: PartnerCommission allows one partner-wide
   *  row per partner and one row per (partner, program), and a row with
   *  a fresh id but a taken natural key must be skipped, not fail the
   *  whole import. */
  conflict?: 'primaryKey' | 'any';
  /** Only rows whose `column` is one of `values` travel. Applied on export
   *  and on import. */
  only?: { column: string; values: readonly string[] };
  credentials?: CredentialSpec;
  sealed?: SealedSpec;
}

/** A token hash no plaintext matches: the restored row keeps its history
 *  and allowlist, but the credential itself is dead until rotated. */
function deadTokenHash(): string {
  return createHash('sha256').update(randomBytes(32)).digest('hex');
}

/** 64 hex chars from the restoring server's CSPRNG (gen_random_uuid is core
 *  since Postgres 13; the dump's docs say so). */
const SQL_RANDOM_HEX = `replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '')`;

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
  // agreed on. One partner-wide row (programId null) and/or one row per
  // program, per partner.
  { table: TABLES.PartnerCommission, primaryKey: 'id', conflict: 'any' },
  // Each partner's own OpenPartner Network opt-in: how and when they
  // consented, withdrew or declined. Keyed on partnerId, one row per
  // partner. Without it a restored instance would forget who agreed to
  // have their details shared with the Network.
  { table: TABLES.PartnerNetworkConsent, primaryKey: 'partnerId' },
  // Where each partner wants manual payouts sent: a PayPal email, bank
  // account, UPI ID or instructions. One row per partner. Sealed at rest,
  // so it travels opened (SealedSpec); without it every partner of a
  // restored program would have to enter their bank details again.
  {
    table: TABLES.PartnerPayoutProfile,
    primaryKey: 'partnerId',
    sealed: { open: openForExport, seal: sealForImport },
  },
  // Coupon-code attribution. A coupon-driven conversion can't be
  // re-derived without the code → (partner, program) mapping.
  { table: TABLES.Coupon, primaryKey: 'id' },
  { table: TABLES.Link, primaryKey: 'id' },
  { table: TABLES.Click, primaryKey: 'id' },
  { table: TABLES.Identity, primaryKey: 'id' },
  { table: TABLES.Event, primaryKey: 'id' },
  { table: TABLES.Attribution, primaryKey: 'id' },
  // Performance bounties: goals on a program that pay a bonus once a
  // partner reaches them. Before Bonus, which names the bounty it paid.
  { table: TABLES.Bounty, primaryKey: 'id' },
  // Rewards not tied to a sale (manual, performance bounty, Network). Each
  // has one Commission (Commission.bonusId), so it goes first.
  { table: TABLES.Bonus, primaryKey: 'id' },
  { table: TABLES.Commission, primaryKey: 'id' },
  { table: TABLES.Payout, primaryKey: 'id' },
  // Sidecar (hosted white-label custom domains). Exported losslessly;
  // edge/billing semantics are inert on self-hosted import — the rows are
  // domain history, and a self-hosted instance derives its own edge.
  { table: TABLES.PortalCustomDomain, primaryKey: 'id' },
  // Core compensating-entry ledger (clawbacks/corrections against paid
  // commissions). Ordered after Commission for FK-safe import.
  { table: TABLES.CommissionAdjustment, primaryKey: 'id' },
  // The marketing-asset library partners pull from. Image rows carry the
  // public URL of the uploaded file, not its bytes — see
  // docs/data-portability.md "Brand asset files".
  { table: TABLES.BrandAsset, primaryKey: 'id' },
  // The brand's outbound webhook endpoints (the delivery log stays out).
  // The signing secret is a credential, so unlike PartnerPayoutProfile it
  // does NOT travel opened even though it is sealed at rest: whoever holds
  // the file could sign deliveries the brand's receivers would trust, and a
  // fresh secret costs the brand one receiver setting per endpoint, not
  // anyone's data (docs/data-portability.md "Credentials"). A restored
  // endpoint gets a fresh secret, sealed, and comes back paused, because
  // its receiver doesn't know it yet. The JSON import report shows the new
  // secrets once; after a SQL restore the admin rotates each one
  // (POST /webhooks/:id/secret), since the sweep seals what the dump wrote.
  {
    table: TABLES.WebhookEndpoint,
    primaryKey: 'id',
    credentials: {
      omit: ['secret', 'secretPrefix'],
      fresh: (row) => {
        const secret = mintSecret();
        return {
          values: { secret: secret.sealed, secretPrefix: secret.prefix, active: false },
          reveal: { id: row.id, url: row.url, secret: secret.plaintext },
        };
      },
      sql: { secret: `'whsec_' || ${SQL_RANDOM_HEX}`, secretPrefix: "''", active: 'false' },
      sqlAfter: (tenantExpr) => [
        `UPDATE "WebhookEndpoint" SET "secretPrefix" = left("secret", 12) WHERE "tenantId" = ${tenantExpr} AND "secretPrefix" = '';`,
      ],
    },
  },
  // Each partner's own tracker callbacks. No credential of ours, but the
  // URL often holds the partner's tracker secret, so it is sealed at rest
  // (postback-url.ts) and travels opened (SealedSpec), as the partner
  // entered it: it is their data, and leaving it out would make every
  // partner set up their tracker again. `urlPreview` is derived from it,
  // so it stays out and the import derives it again.
  {
    table: TABLES.PartnerPostback,
    primaryKey: 'id',
    sealed: { open: openPostbackForExport, seal: sealPostbackForImport },
  },
  // The inbound GET /postback credential: allowlist and rotation history
  // travel, the token hash doesn't. A restored live token matches no URL
  // until it is rotated (Integrations page), which keeps its allowlist.
  // One live token per tenant is a partial unique index, so a destination
  // that already has one keeps it ('any').
  {
    table: TABLES.ConversionPostbackToken,
    primaryKey: 'id',
    conflict: 'any',
    credentials: {
      omit: ['tokenHash'],
      fresh: () => ({ values: { tokenHash: deadTokenHash() } }),
      sql: { tokenHash: `encode(sha256(convert_to(${SQL_RANDOM_HEX}, 'UTF8')), 'hex')` },
    },
  },
  // Program and portal settings. Primary key (tenantId, key); a setting the
  // destination already has wins.
  {
    table: TABLES.Config,
    primaryKey: 'key',
    conflict: 'any',
    only: { column: 'key', values: PORTABLE_CONFIG_KEYS },
  },
] as const satisfies readonly ExportTableSpec[];

export type ExportableTable = (typeof EXPORT_TABLES)[number]['table'];

export const EXPORTABLE_TABLES = EXPORT_TABLES.map((s) => s.table) as readonly ExportableTable[];

// Import order respects FK dependencies: parents first.
export const IMPORT_ORDER = EXPORT_TABLES;

function specOf(table: string): ExportTableSpec | undefined {
  return (EXPORT_TABLES as readonly ExportTableSpec[]).find((s) => s.table === table);
}

export function primaryKeyOf(table: string): string {
  return specOf(table)?.primaryKey ?? 'id';
}

/** Does this row travel? (ExportTableSpec.only) */
function isPortableRow(spec: ExportTableSpec, row: Record<string, unknown>): boolean {
  return !spec.only || spec.only.values.includes(row[spec.only.column] as string);
}

function withoutColumns(row: Record<string, unknown>, columns: readonly string[]): Record<string, unknown> {
  const out = { ...row };
  for (const c of columns) delete out[c];
  return out;
}

function conflictModeOf(spec: ExportTableSpec): 'primaryKey' | 'any' {
  return spec.conflict ?? 'primaryKey';
}

/**
 * The id a pre-v3 PartnerCommission row gets. Must match the
 * `'pcm_' || "partnerId"` backfill in migration
 * 20261016000000_partner_commission_program_scope, so a bundle exported
 * before that migration and imported after it gets the same ids the
 * migrated instance has.
 */
export function legacyPartnerCommissionId(partnerId: string): string {
  return `pcm_${partnerId}`;
}

/**
 * Rewrite older rows into the current shape. Pure — returns a new bundle.
 *
 * PartnerCommission before program scoping (bundles up to v2): one row per
 * partner, keyed on partnerId, applying to all of the partner's programs.
 * That is exactly a partner-wide row today: `programId` null, plus the id
 * the migration gave existing rows. (v1 bundles have no PartnerCommission.)
 *
 * Keyed on the row's shape (no `id`), not on the bundle's version number,
 * so it stays right however versions are numbered — every row exported
 * since the change carries a NOT NULL `id` and is left alone.
 */
export function upgradeBundle(bundle: ImportBundle): ImportBundle {
  const rows = bundle[TABLES.PartnerCommission];
  if (!Array.isArray(rows)) return bundle;
  return {
    ...bundle,
    [TABLES.PartnerCommission]: rows.map((r) => {
      const row = r as Record<string, unknown>;
      if (row.id != null) return row;
      return { ...row, id: legacyPartnerCommissionId(String(row.partnerId)), programId: null };
    }),
  };
}

export function isExportable(name: string): name is ExportableTable {
  return (EXPORTABLE_TABLES as readonly string[]).includes(name);
}

/**
 * Read one table for export.
 *
 * `tenantId` is REQUIRED and applied as an explicit filter, rather than
 * leaning on RLS alone (round-6 review). RLS is still the outer guarantee
 * and every exportable table has a policy — but `appDb` falls back to the
 * privileged `DATABASE_URL` when `DATABASE_URL_APP` is unset, which db.ts
 * documents as a supported self-host configuration on the grounds that
 * "app-level tenantId filtering still applies". That was true everywhere
 * except here: an unfiltered `select *` on a privileged pool returns every
 * tenant's rows, so the export was the one path that broke the codebase's
 * own safety net.
 *
 * Every table in EXPORT_TABLES carries `tenantId`, so this is complete
 * rather than best-effort.
 *
 * Every format goes through here, so this is also where credential
 * columns are dropped and non-portable rows (ExportTableSpec.only) left out.
 */
export async function exportTable(
  db: Knex,
  table: ExportableTable,
  tenantId: string,
): Promise<unknown[]> {
  const spec = specOf(table)!;
  const query = db(table).where({ tenantId });
  if (spec.only) query.whereIn(spec.only.column, spec.only.values);
  const rows = (await query.select('*')) as Record<string, unknown>[];
  const omit = spec.credentials?.omit;
  const out = omit ? rows.map((r) => withoutColumns(r, omit)) : rows;
  return spec.sealed ? out.map(spec.sealed.open) : out;
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

export async function exportAll(db: Knex, tenantId: string): Promise<Record<string, unknown[]>> {
  const out: Record<string, unknown[]> = {};
  for (const { table } of EXPORT_TABLES) {
    out[table] = await exportTable(db, table as ExportableTable, tenantId);
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
 * Every statement is `ON CONFLICT (pk) DO NOTHING` (bare `ON CONFLICT DO
 * NOTHING` for a table whose spec says conflict: 'any'), so a restore is
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

  for (const spec of EXPORT_TABLES as readonly ExportTableSpec[]) {
    const { table, primaryKey } = spec;
    const onConflict = conflictModeOf(spec) === 'any' ? 'ON CONFLICT DO NOTHING;' : `ON CONFLICT (${quoteIdent(primaryKey)}) DO NOTHING;`;
    const rows = (bundle[table] ?? []) as Record<string, unknown>[];
    if (rows.length === 0) {
      out.push(`-- ${table}: no rows`);
      out.push('');
      continue;
    }
    const types = opts.columnTypes?.[table] ?? {};
    // Credential columns are written by the restoring server, never taken
    // from the bundle (CredentialSpec.sql).
    const fresh: Record<string, string> = spec.credentials?.sql ?? {};
    const columns = Array.from(new Set([...rows.flatMap((r) => Object.keys(r)), ...Object.keys(fresh)]));
    const columnList = columns.map(quoteIdent).join(', ');
    out.push(`-- ${table} (${rows.length} row${rows.length === 1 ? '' : 's'})`);
    if (spec.credentials) {
      out.push(`-- Not exported: ${spec.credentials.omit.join(', ')}. Fresh values are generated on restore.`);
    }
    if (spec.sealed) {
      out.push('-- Sealed at rest, written here opened: the API seals each row again (a sweep soon after startup, then hourly).');
    }
    for (let i = 0; i < rows.length; i += chunkSize) {
      const chunk = rows.slice(i, i + chunkSize);
      const values = chunk.map(
        (row) =>
          `  (${columns
            .map((c) => (c === 'tenantId' ? tenantExpr : (fresh[c] ?? sqlLiteral(row[c], types[c]))))
            .join(', ')})`,
      );
      out.push(`INSERT INTO ${quoteIdent(table)} (${columnList}) VALUES`);
      out.push(values.join(',\n'));
      out.push(onConflict);
    }
    out.push(...(spec.credentials?.sqlAfter?.(tenantExpr) ?? []));
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
  // A json/jsonb column holds JSON, whatever JS type the driver handed back.
  //
  // This used to serialize only when `typeof v === 'object'`, which is wrong
  // because pg parses json/jsonb through JSON.parse: a stored `'"hello"'`
  // arrives as the JS STRING `hello` and was emitted as the SQL literal
  // 'hello' — not valid JSON, so the restore failed outright. Same for a
  // stored number or boolean. Scalars are legal JSON values and a NOT NULL
  // jsonb column accepts every one of them (round-6 review).
  //
  // Known residual, documented in docs/data-portability.md: a JS `null` from
  // a json column is indistinguishable from SQL NULL after `select *`, so
  // JSON `null` exports as SQL NULL. On a NOT NULL json column that restore
  // fails loudly rather than corrupting anything.
  if (isJsonType(pgType)) return escapeString(JSON.stringify(v));
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
  /** Fresh credentials for restored rows, per table — shown once, like a
   *  webhook secret at creation (CredentialSpec.fresh's `reveal`). */
  credentials: Record<string, Array<Record<string, unknown>>>;
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
 *
 * Rows from older bundles are upgraded to the current shape first
 * (upgradeBundle).
 */
export async function importBundle(
  db: Knex,
  tenantId: string,
  bundle: ImportBundle,
): Promise<ImportReport> {
  const inserted: Record<string, number> = {};
  const skipped: Record<string, number> = {};
  const credentials: Record<string, Array<Record<string, unknown>>> = {};
  const current = upgradeBundle(bundle);

  for (const spec of IMPORT_ORDER as readonly ExportTableSpec[]) {
    const { table, primaryKey } = spec;
    const rows = current[table];
    if (!Array.isArray(rows) || rows.length === 0) continue;
    const portable = (rows as Record<string, unknown>[]).filter((r) => isPortableRow(spec, r));
    if (portable.length === 0) {
      inserted[table] = 0;
      skipped[table] = rows.length;
      continue;
    }

    // Read the destination's column types once per table. Without this a
    // JSON array (Program.commissionRule) is handed to the driver as a
    // Postgres array literal and the whole import fails.
    const types = await tableColumnTypes(db, table);
    const reveals = new Map<string, Record<string, unknown>>();
    const normalized = portable.map((r) => {
      const normalized = { ...normalizeRow(r, types), tenantId };
      const row: Record<string, unknown> = spec.sealed ? spec.sealed.seal(normalized) : normalized;
      if (!spec.credentials) return row;
      // A bundle never carries credentials; a hand-made one that does is
      // ignored like any other.
      const { values, reveal } = spec.credentials.fresh(row);
      if (reveal) reveals.set(String(row[primaryKey]), reveal);
      return { ...withoutColumns(row, spec.credentials.omit), ...values };
    });

    // The conflict target has to be the table's REAL primary key —
    // assuming `id` silently broke every table keyed on something else
    // (PartnerCommission was keyed on partnerId until schemaVersion 3).
    // Tables with a separate natural key skip on any unique collision.
    const insert = db(table).insert(normalized);
    const result = await (conflictModeOf(spec) === 'any' ? insert.onConflict() : insert.onConflict(primaryKey))
      .ignore()
      .returning(primaryKey);

    inserted[table] = result.length;
    skipped[table] = rows.length - result.length;
    // Only rows that landed: a skipped row kept the destination's own
    // credential, so there is nothing new to show.
    const shown = (result as Array<Record<string, unknown>>)
      .map((r) => reveals.get(String(r[primaryKey])))
      .filter((r): r is Record<string, unknown> => !!r);
    if (shown.length > 0) credentials[table] = shown;
  }

  return { inserted, skipped, credentials };
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
    } else if (isJsonType(types[k]) && v !== null) {
      // Serialize json/jsonb ourselves. The driver renders a bare JS array
      // as a Postgres array literal, which a json column rejects.
      //
      // The `typeof v === 'object'` guard this used to carry let scalars
      // through unserialized: pg parses json/jsonb via JSON.parse, so a
      // stored `'"hello"'` arrives as a plain JS string and was passed to
      // the driver as `hello`, which the column rejects. Scalars are legal
      // JSON and must be re-serialized like anything else (round-6 review).
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
