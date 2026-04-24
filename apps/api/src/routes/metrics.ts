/**
 * Prometheus metrics endpoint.
 *
 * Plain text exposition. Numbers are row counts — attribution volume,
 * commission + payout status distribution, fraud rate. No IDs, no PII,
 * so a self-hoster can scrape from an internal Prometheus without
 * auth. If METRICS_TOKEN is set, scrapes must include
 * `Authorization: Bearer $METRICS_TOKEN` — use this when /metrics is
 * reachable from the public internet.
 *
 * Intentionally DB-backed rather than in-process counters so that
 * restarts don't zero the gauges and multi-instance deploys agree.
 * A scrape runs a handful of count queries — cheap even at millions
 * of clicks.
 */

import { Router } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { TABLES } from '@openpartner/db';
import { db } from '../db.js';

export const metricsRouter = Router();

function safeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  // timingSafeEqual requires equal lengths; pad to the longer buffer so
  // the mismatching-length branch still runs in ~constant time.
  if (aBuf.length !== bBuf.length) {
    // Still consume a fixed-size comparison so length alone isn't a
    // timing signal. The return is always false when lengths differ.
    const fixed = Buffer.alloc(32);
    timingSafeEqual(fixed, Buffer.alloc(32));
    return false;
  }
  return timingSafeEqual(aBuf, bBuf);
}

metricsRouter.get('/metrics', async (req, res) => {
  const expected = process.env.METRICS_TOKEN;
  if (expected) {
    const header = req.header('authorization') ?? '';
    const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!safeEqual(presented, expected)) {
      return res.status(401).json({ error: 'unauthorized' });
    }
  }

  const [
    clicks,
    clicksFlagged,
    identities,
    events,
    attributions,
    commissionsByStatus,
    payoutsByStatus,
  ] = await Promise.all([
    db(TABLES.Click).count<{ count: string }[]>('* as count').first(),
    db(TABLES.Click).whereNotNull('fraudFlag').count<{ count: string }[]>('* as count').first(),
    db(TABLES.Identity).count<{ count: string }[]>('* as count').first(),
    db(TABLES.Event).count<{ count: string }[]>('* as count').first(),
    db(TABLES.Attribution).count<{ count: string }[]>('* as count').first(),
    db(TABLES.Commission).select('status').count<{ status: string; count: string }[]>('* as count').groupBy('status'),
    db(TABLES.Payout).select('status').count<{ status: string; count: string }[]>('* as count').groupBy('status'),
  ]);

  const lines: string[] = [];

  const gauge = (name: string, help: string, value: number, labels?: Record<string, string>) => {
    if (!lines.some((l) => l === `# TYPE ${name} counter`)) {
      lines.push(`# HELP ${name} ${help}`);
      lines.push(`# TYPE ${name} counter`);
    }
    const label = labels ? `{${Object.entries(labels).map(([k, v]) => `${k}="${v}"`).join(',')}}` : '';
    lines.push(`${name}${label} ${value}`);
  };

  gauge('openpartner_clicks_total', 'Lifetime count of Click rows.', Number(clicks?.count ?? 0));
  gauge('openpartner_clicks_flagged_total', 'Clicks flagged for fraud (velocity, manual).', Number(clicksFlagged?.count ?? 0));
  gauge('openpartner_identities_total', 'Lifetime count of Identity rows (stitched).', Number(identities?.count ?? 0));
  gauge('openpartner_events_total', 'Lifetime count of Event rows.', Number(events?.count ?? 0));
  gauge('openpartner_attributions_total', 'Lifetime count of Attribution rows.', Number(attributions?.count ?? 0));

  for (const row of commissionsByStatus) {
    gauge('openpartner_commissions_total', 'Commission rows by status.', Number(row.count), { status: row.status });
  }
  for (const row of payoutsByStatus) {
    gauge('openpartner_payouts_total', 'Payout rows by status.', Number(row.count), { status: row.status });
  }

  res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
  res.send(lines.join('\n') + '\n');
});
