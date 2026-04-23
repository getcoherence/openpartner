import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db.js';
import { requireAdmin, requireAuth } from '../auth.js';
import { exportAll, exportTable, importBundle, isExportable, rowsToCsv } from '../export.js';
import { getMode } from '../stripe.js';

export const exportRouter = Router();

exportRouter.get('/export/:table.:format', requireAuth, requireAdmin, async (req, res) => {
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
  res.status(400).json({ error: 'unsupported_format', detail: 'use json or csv' });
});

exportRouter.get('/export.json', requireAuth, requireAdmin, async (_req, res) => {
  const bundle = await exportAll(db);
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', 'attachment; filename="openpartner-export.json"');
  res.json({
    exportedAt: new Date().toISOString(),
    schemaVersion: 1,
    tables: bundle,
  });
});

const importSchema = z.object({
  schemaVersion: z.number().int(),
  tables: z.record(z.array(z.record(z.unknown()))),
});

exportRouter.post('/import', requireAuth, requireAdmin, async (req, res) => {
  // Safety rail: re-importing someone else's export into a shared hosted DB
  // would collide primary keys and leak cross-tenant data. Gate it to selfhost.
  if (getMode() !== 'selfhost') {
    return res.status(403).json({ error: 'import_disabled_on_hosted', detail: 'OPENPARTNER_MODE must be selfhost' });
  }
  const body = importSchema.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });
  if (body.data.schemaVersion !== 1) {
    return res.status(400).json({ error: 'unsupported_schema_version' });
  }
  const report = await importBundle(db, body.data.tables);
  res.json({ ok: true, report });
});
