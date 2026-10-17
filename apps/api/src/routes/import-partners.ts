/**
 * Partner-roster CSV importer.
 *
 *   POST /import/partners-csv?dryRun=true|false
 *   Content-Type: text/csv  (raw CSV body)
 *
 * Lets brands migrate from competitors (Impact, Rewardful, Refersion, etc.)
 * by adapting their export to a single canonical OpenPartner format and
 * uploading. Multi-format auto-detection is deferred — documenting one
 * canonical format is simpler and ships now.
 *
 * Canonical CSV columns (header row required):
 *
 *   email           required, becomes Partner.email
 *   name            required, becomes Partner.name
 *   activatedAt     optional ISO datetime, defaults to now (existing
 *                   partners come in already-activated; new invites
 *                   should leave blank + use POST /partners with
 *                   sendInvite=true instead)
 *   metadata        optional JSON object string, merged into Partner.metadata
 *
 * Behavior:
 *   - dryRun=true  parses + validates + returns preview + would-be results
 *                  without writing anything
 *   - dryRun=false (or missing) commits the import — creates Partner rows,
 *                  granting access to ALL current campaigns by default
 *                  (matches the per-partner default behavior elsewhere)
 *   - Per-row email_taken collisions are reported as skipped, not errors —
 *     re-running the import is idempotent on already-imported emails.
 */

import { Router } from 'express';
import { ulid } from 'ulid';
import { TABLES, type PartnerRow } from '@openpartner/db';
import { grantScope, requireAdmin, requireAuth } from '../auth.js';
import { tenantOf } from '../tenancy.js';

export const importPartnersRouter = Router();

interface RowReport {
  row: number;
  email: string;
  status: 'created' | 'skipped_email_taken' | 'invalid';
  reason?: string;
  partnerId?: string;
}

importPartnersRouter.post(
  '/import/partners-csv',
  requireAuth,
  grantScope('partners:write'),
  requireAdmin,
  // Read raw text body — we don't want express.json() to interpret it.
  // The /import route already uses 256mb json limit; partner rosters are
  // small enough that the global 1mb limit suits.
  (req, res, next) => {
    if (req.is('text/*') || req.is('application/csv') || req.is('text/csv')) {
      let raw = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        (req as { rawCsv?: string }).rawCsv = raw;
        next();
      });
    } else {
      // Allow JSON shape `{ csv: "...." }` as a fallback for tools that
      // can't set the content-type.
      const csv = typeof req.body?.csv === 'string' ? req.body.csv : '';
      (req as { rawCsv?: string }).rawCsv = csv;
      next();
    }
  },
  async (req, res) => {
    const { db, tenantId } = tenantOf(req);
    const csv = ((req as { rawCsv?: string }).rawCsv ?? '').trim();
    if (!csv) return res.status(400).json({ error: 'empty_body', detail: 'POST the CSV as text/csv body' });

    const dryRun = req.query.dryRun === 'true' || req.query.dryRun === '1';

    let rows: Array<Record<string, string>>;
    try {
      rows = parseCsv(csv);
    } catch (err) {
      return res.status(400).json({ error: 'invalid_csv', detail: err instanceof Error ? err.message : String(err) });
    }
    if (rows.length === 0) return res.status(400).json({ error: 'no_rows', detail: 'CSV had a header but no data rows' });

    // Pull the campaign list once — every newly-created partner gets
    // access to all current campaigns (the same default as POST /partners
    // when programIds is omitted). Done outside the loop so we don't
    // re-query per row.
    const allCampaigns = (await db(TABLES.Program).select('id')) as Array<{ id: string }>;
    const allCampaignIds = allCampaigns.map((c) => c.id);

    const report: RowReport[] = [];

    for (let i = 0; i < rows.length; i += 1) {
      const r = rows[i]!;
      const rowNum = i + 2; // +1 for header, +1 to match human row counting

      const email = (r.email ?? '').trim().toLowerCase();
      const name = (r.name ?? '').trim();
      if (!email || !email.includes('@')) {
        report.push({ row: rowNum, email, status: 'invalid', reason: 'invalid_email' });
        continue;
      }
      if (!name) {
        report.push({ row: rowNum, email, status: 'invalid', reason: 'missing_name' });
        continue;
      }

      const existing = await db<PartnerRow>(TABLES.Partner).where({ email }).first();
      if (existing) {
        report.push({ row: rowNum, email, status: 'skipped_email_taken', partnerId: existing.id });
        continue;
      }

      let metadata: Record<string, unknown> = { importedFromCsv: true };
      if (r.metadata) {
        try {
          const parsed = JSON.parse(r.metadata);
          if (parsed && typeof parsed === 'object') metadata = { ...metadata, ...parsed };
        } catch {
          report.push({ row: rowNum, email, status: 'invalid', reason: 'metadata_not_valid_json' });
          continue;
        }
      }

      const activatedAt = r.activatedAt ? new Date(r.activatedAt) : new Date();
      if (Number.isNaN(activatedAt.getTime())) {
        report.push({ row: rowNum, email, status: 'invalid', reason: 'invalid_activatedAt' });
        continue;
      }

      const id = ulid();
      if (!dryRun) {
        await db<PartnerRow>(TABLES.Partner).insert({
          id,
          tenantId,
          email,
          name,
          metadata,
          activatedAt,
        });
        if (allCampaignIds.length > 0) {
          await db(TABLES.PartnerProgram)
            .insert(
              allCampaignIds.map((cid) => ({
                id: `pc_${ulid()}`,
                tenantId,
                partnerId: id,
                programId: cid,
                source: 'admin',
              })),
            )
            .onConflict(['tenantId', 'partnerId', 'programId'])
            .ignore();
        }
      }
      report.push({ row: rowNum, email, status: 'created', partnerId: id });
    }

    const summary = {
      total: rows.length,
      created: report.filter((r) => r.status === 'created').length,
      skipped: report.filter((r) => r.status === 'skipped_email_taken').length,
      invalid: report.filter((r) => r.status === 'invalid').length,
    };
    res.json({ dryRun, summary, report });
  },
);

/**
 * Minimal CSV parser. Handles the canonical case (no quoted fields with
 * embedded commas/newlines). Rejects anything weird so users notice
 * the format mismatch instead of silently importing garbage.
 */
function parseCsv(input: string): Array<Record<string, string>> {
  const lines = input.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) throw new Error('expected a header row plus at least one data row');
  const header = splitCsvLine(lines[0]!);
  const rows: Array<Record<string, string>> = [];
  for (let i = 1; i < lines.length; i += 1) {
    const cells = splitCsvLine(lines[i]!);
    if (cells.length !== header.length) {
      throw new Error(`row ${i + 1} has ${cells.length} columns, expected ${header.length} from header`);
    }
    const row: Record<string, string> = {};
    for (let j = 0; j < header.length; j += 1) {
      row[header[j]!] = cells[j]!;
    }
    rows.push(row);
  }
  return rows;
}

/**
 * Splits a CSV line on commas, respecting double-quoted fields with
 * doubled-quote escaping ("Smith, John" or "she said ""hi"""). Doesn't
 * handle multi-line quoted fields — those need a real parser, and they
 * don't show up in partner-roster imports in practice.
 */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i += 1; }
        else { inQuotes = false; }
      } else {
        cur += ch;
      }
    } else {
      if (ch === ',') { out.push(cur); cur = ''; }
      else if (ch === '"' && cur.length === 0) { inQuotes = true; }
      else { cur += ch; }
    }
  }
  out.push(cur);
  return out.map((s) => s.trim());
}
