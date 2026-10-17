/**
 * afterCommit (tenancy.ts): work that must only describe durable state —
 * a Network push — runs after the request transaction commits, in a
 * transaction of its own, and never for a request that rolled back.
 *
 * Skipped if DATABASE_URL isn't set.
 */

import express from 'express';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { DEFAULT_TENANT_ID, TABLES } from '@openpartner/db';

process.env.OPENPARTNER_TENANCY = 'single';

const { db } = await import('../db.js');
const { afterCommit, tenantMiddleware, tenantOf } = await import('../tenancy.js');

const skipIntegration = !process.env.DATABASE_URL || process.env.INTEGRATION === 'skip';
const KEY = 'after_commit_test';

/** What each job saw from outside the request transaction. */
let seen: Array<{ label: string; committed: boolean }> = [];

async function committedRow(): Promise<boolean> {
  return !!(await db(TABLES.Config).where({ tenantId: DEFAULT_TENANT_ID, key: KEY }).first());
}

const app = express();
app.use(tenantMiddleware);
app.post('/write/:outcome', async (req, res) => {
  const { db: trx, tenantId } = tenantOf(req);
  await trx(TABLES.Config).insert({ tenantId, key: KEY, value: { at: Date.now() } as unknown as never, updatedAt: new Date() });
  afterCommit(req, 'first', async (jobTrx) => {
    seen.push({ label: 'first', committed: await committedRow() });
    // The job's own transaction is tenant-scoped like the request's.
    const row = await jobTrx(TABLES.Config).where({ key: KEY }).first();
    if (!row) throw new Error('job transaction cannot see the committed row');
  });
  if (req.params.outcome === 'job-throws') {
    afterCommit(req, 'throws', async () => {
      throw new Error('boom');
    });
  }
  afterCommit(req, 'last', async () => {
    seen.push({ label: 'last', committed: await committedRow() });
  });
  if (req.params.outcome === 'fail') return res.status(500).json({ error: 'failed_after_queueing' });
  res.json({ ok: true });
});

beforeEach(async () => {
  if (skipIntegration) return;
  seen = [];
  await db(TABLES.Config).where({ tenantId: DEFAULT_TENANT_ID, key: KEY }).del();
});

afterAll(async () => {
  if (!skipIntegration) await db(TABLES.Config).where({ tenantId: DEFAULT_TENANT_ID, key: KEY }).del();
  await db.destroy();
});

describe.skipIf(skipIntegration)('afterCommit', () => {
  it('runs queued jobs in order once the request has committed, before the response', async () => {
    const res = await request(app).post('/write/ok');
    expect(res.status).toBe(200);
    expect(seen).toEqual([
      { label: 'first', committed: true },
      { label: 'last', committed: true },
    ]);
  });

  it('runs nothing for a request that rolled back', async () => {
    const res = await request(app).post('/write/fail');
    expect(res.status).toBe(500);
    expect(seen).toEqual([]);
    expect(await committedRow()).toBe(false);
  });

  it('a failing job is logged; the request and the other jobs still succeed', async () => {
    const res = await request(app).post('/write/job-throws');
    expect(res.status).toBe(200);
    expect(seen.map((s) => s.label)).toEqual(['first', 'last']);
    expect(await committedRow()).toBe(true);
  });
});
