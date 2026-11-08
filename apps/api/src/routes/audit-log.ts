/**
 * The brand's audit log (audit-log.ts, docs/audit-log.md).
 *
 *   GET /audit-log          newest first, keyset-paginated, filterable.
 *   GET /audit-log/actors   who the log names, for the actorId filter.
 *   GET /audit-log.csv      the same filters, as a file (itself logged).
 *
 * Full admins and admin API keys only: entries name teammates and their IP
 * addresses, so view-only seats don't read them (view-only.ts).
 */

import { Router } from 'express';
import type { Knex } from 'knex';
import { z } from '../zod.js';
import { TABLES, type AuditLogRow } from '@openpartner/db';
import { requireAdmin, requireAuth } from '../auth.js';
import { AUDIT_ACTION_LABELS } from '../audit-log.js';
import { rowsToCsv } from '../export.js';
import { cursorTimestamp, decodeCursor, takePage, whereAfterCursor } from '../pagination.js';
import { tenantOf } from '../tenancy.js';

export const auditLogRouter = Router();

/** The most rows one CSV download carries; narrow the dates for more. */
export const AUDIT_CSV_MAX_ROWS = 50_000;

export const listAuditLogQuerySchema = z.object({
  actorId: z.string().min(1).max(64).optional(),
  action: z.string().min(1).max(200).optional(),
  targetId: z.string().min(1).max(200).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
  cursor: z.string().optional(),
});

type Filters = z.infer<typeof listAuditLogQuerySchema>;

/** The records a target id can be named from, keyed on the path's first
 *  segment, with the column that names one. */
const TARGET_NAMES: Record<string, { table: string; column: string }> = {
  programs: { table: TABLES.Program, column: 'name' },
  partners: { table: TABLES.Partner, column: 'name' },
  admins: { table: TABLES.Admin, column: 'email' },
  bounties: { table: TABLES.Bounty, column: 'name' },
  'api-keys': { table: TABLES.ApiKey, column: 'label' },
};

function filtered(db: Knex, tenantId: string, f: Filters): Knex.QueryBuilder {
  const q = db<AuditLogRow>(`${TABLES.AuditLog} as a`).where('a.tenantId', tenantId);
  if (f.actorId) q.andWhere('a.actorId', f.actorId);
  if (f.action) q.andWhere('a.action', f.action);
  if (f.targetId) q.andWhere('a.targetId', f.targetId);
  if (f.from) q.andWhere('a.createdAt', '>=', f.from);
  if (f.to) q.andWhere('a.createdAt', '<', f.to);
  return q;
}

function targetKind(action: string): string | null {
  const m = /^[A-Z]+ \/([^/.]+)/.exec(action);
  return m && m[1]! in TARGET_NAMES ? m[1]! : null;
}

/** What each entry's target is called now, where the record still exists. */
async function targetNames(db: Knex, tenantId: string, rows: AuditLogRow[]): Promise<Map<string, string>> {
  const wanted = new Map<string, Set<string>>();
  for (const row of rows) {
    const kind = targetKind(row.action);
    if (kind && row.targetId) (wanted.get(kind) ?? wanted.set(kind, new Set()).get(kind)!).add(row.targetId);
  }
  const names = new Map<string, string>();
  for (const [kind, ids] of wanted) {
    const { table, column } = TARGET_NAMES[kind]!;
    const found = (await db(table).where({ tenantId }).whereIn('id', [...ids]).select('id', column)) as Array<Record<string, string | null>>;
    for (const r of found) if (r[column]) names.set(`${kind}:${r.id}`, r[column]!);
  }
  return names;
}

function view(row: AuditLogRow, names: Map<string, string>) {
  const kind = targetKind(row.action);
  return {
    id: row.id,
    createdAt: row.createdAt,
    actorKind: row.actorKind,
    actorId: row.actorId,
    actorLabel: row.actorLabel,
    action: row.action,
    label: AUDIT_ACTION_LABELS[row.action] ?? null,
    targetId: row.targetId,
    targetName: kind && row.targetId ? (names.get(`${kind}:${row.targetId}`) ?? null) : null,
    params: row.params,
    fields: row.fields,
    detail: row.detail,
    status: row.status,
    ip: row.ip,
  };
}

auditLogRouter.get('/audit-log', requireAuth, requireAdmin, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  const q = listAuditLogQuerySchema.safeParse(req.query);
  if (!q.success) return res.status(400).json({ error: 'invalid_query', detail: q.error.flatten() });

  const query = filtered(db, tenantId, q.data)
    .select('a.*', cursorTimestamp(db, 'a.createdAt'))
    .orderBy([{ column: 'a.createdAt', order: 'desc' }, { column: 'a.id', order: 'desc' }])
    .limit(q.data.limit + 1);
  if (q.data.cursor) {
    const cursor = decodeCursor(q.data.cursor);
    if (!cursor) return res.status(400).json({ error: 'invalid_cursor' });
    whereAfterCursor(query, 'a.createdAt', 'a.id', cursor);
  }
  const { page, nextCursor } = takePage((await query) as Array<AuditLogRow & { _cursorTs: string }>, q.data.limit);
  const names = await targetNames(db, tenantId, page);
  res.json({ entries: page.map((r) => view(r, names)), nextCursor });
});

/** Everyone the log names (but the operator key), with their latest label:
 *  the choices for the actorId filter, revoked admins and keys included. */
auditLogRouter.get('/audit-log/actors', requireAuth, requireAdmin, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  const { rows } = await db.raw<{ rows: Array<Pick<AuditLogRow, 'actorId' | 'actorKind' | 'actorLabel'>> }>(
    `select distinct on ("actorId") "actorId", "actorKind", "actorLabel"
       from ?? where "tenantId" = ? and "actorId" is not null
      order by "actorId", "createdAt" desc`,
    [TABLES.AuditLog, tenantId],
  );
  const actors = rows
    .map((r) => ({ actorId: r.actorId!, actorKind: r.actorKind, actorLabel: r.actorLabel }))
    .sort((a, b) => a.actorKind.localeCompare(b.actorKind) || (a.actorLabel ?? '').localeCompare(b.actorLabel ?? ''));
  res.json({ actors });
});

auditLogRouter.get('/audit-log.csv', requireAuth, requireAdmin, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  const q = listAuditLogQuerySchema.omit({ limit: true, cursor: true }).safeParse(req.query);
  if (!q.success) return res.status(400).json({ error: 'invalid_query', detail: q.error.flatten() });

  const rows = (await filtered(db, tenantId, { ...q.data, limit: AUDIT_CSV_MAX_ROWS })
    .select('a.*')
    .orderBy([{ column: 'a.createdAt', order: 'desc' }, { column: 'a.id', order: 'desc' }])
    .limit(AUDIT_CSV_MAX_ROWS)) as AuditLogRow[];
  const names = await targetNames(db, tenantId, rows);
  const csv = rowsToCsv(
    rows.map((r) => {
      const v = view(r, names);
      return {
        createdAt: v.createdAt,
        actorKind: v.actorKind,
        actorId: v.actorId,
        actor: v.actorLabel,
        action: v.action,
        label: v.label,
        targetId: v.targetId,
        targetName: v.targetName,
        params: v.params,
        fields: v.fields,
        detail: v.detail,
        status: v.status,
        ip: v.ip,
      };
    }),
  );
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="audit-log.csv"');
  res.send(csv);
});
