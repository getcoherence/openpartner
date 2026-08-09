import { Router } from 'express';
import { z } from 'zod';
import { requireAdmin, requireAuth } from '../auth.js';
import {
  SCHEMA_VERSION,
  SUPPORTED_IMPORT_VERSIONS,
  buildSqlDump,
  exportAll,
  exportColumnTypes,
  exportTable,
  tableColumnTypes,
  importBundle,
  isExportable,
  rowsToCsv,
} from '../export.js';
import { getMode } from '../stripe.js';
import { tenantOf } from '../tenancy.js';

export const exportRouter = Router();

/**
 * Per-table export. All three promised formats (CLAUDE.md principle #2):
 * json, csv, sql.
 */
exportRouter.get('/export/:table.:format', requireAuth, requireAdmin, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  const table = req.params.table ?? '';
  const format = req.params.format ?? '';
  if (!isExportable(table)) return res.status(404).json({ error: 'table_not_exportable' });

  const rows = await exportTable(db, table);

  if (format === 'json') {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${table}.json"`);
    return res.json(rows);
  }
  if (format === 'csv') {
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${table}.csv"`);
    return res.send(rowsToCsv(rows as Record<string, unknown>[]));
  }
  if (format === 'sql') {
    res.setHeader('Content-Type', 'application/sql');
    res.setHeader('Content-Disposition', `attachment; filename="${table}.sql"`);
    return res.send(
      buildSqlDump(
        { [table]: rows },
        {
          sourceTenantId: tenantId,
          columnTypes: { [table]: await tableColumnTypes(db, table) },
          ...literalTenant(req.query),
        },
      ),
    );
  }
  res.status(400).json({ error: 'unsupported_format', detail: 'use json, csv, or sql' });
});

exportRouter.get('/export.json', requireAuth, requireAdmin, async (req, res) => {
  const { db } = tenantOf(req);
  const bundle = await exportAll(db);
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', 'attachment; filename="openpartner-export.json"');
  res.json({
    exportedAt: new Date().toISOString(),
    schemaVersion: SCHEMA_VERSION,
    tables: bundle,
  });
});

/**
 * Full tenant dump as SQL. Portable by default: rows are written under a
 * psql variable, so the file restores into any instance —
 *
 *   psql "$DATABASE_URL" -v tenant_id=default -f openpartner-export.sql
 *
 * `?tenantId=<id>` bakes a literal instead, for clients that don't speak
 * psql meta-commands.
 */
exportRouter.get('/export.sql', requireAuth, requireAdmin, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  const bundle = await exportAll(db);
  res.setHeader('Content-Type', 'application/sql');
  res.setHeader('Content-Disposition', 'attachment; filename="openpartner-export.sql"');
  res.send(
    buildSqlDump(bundle, {
      sourceTenantId: tenantId,
      columnTypes: await exportColumnTypes(db),
      ...literalTenant(req.query),
    }),
  );
});

/** `?tenantId=` (present and non-empty) switches the dump to literal mode. */
function literalTenant(query: unknown): { tenantId?: string } {
  const raw = (query as Record<string, unknown> | undefined)?.tenantId;
  return typeof raw === 'string' && raw.length > 0 ? { tenantId: raw } : {};
}

const importSchema = z.object({
  schemaVersion: z.number().int(),
  tables: z.record(z.array(z.record(z.unknown()))),
});

exportRouter.post('/import', requireAuth, requireAdmin, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  // Safety rail: re-importing someone else's export into a shared hosted DB
  // would collide primary keys and leak cross-tenant data. Gate it to selfhost.
  if (getMode() !== 'selfhost') {
    return res.status(403).json({ error: 'import_disabled_on_hosted', detail: 'OPENPARTNER_MODE must be selfhost' });
  }
  const body = importSchema.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });
  // Older bundles are still importable — a v1 export people have on disk
  // must not become worthless because we added tables (principle #2).
  if (!(SUPPORTED_IMPORT_VERSIONS as readonly number[]).includes(body.data.schemaVersion)) {
    return res.status(400).json({
      error: 'unsupported_schema_version',
      detail: `supported: ${SUPPORTED_IMPORT_VERSIONS.join(', ')}`,
    });
  }
  const report = await importBundle(db, tenantId, body.data.tables);
  res.json({ ok: true, report });
});
