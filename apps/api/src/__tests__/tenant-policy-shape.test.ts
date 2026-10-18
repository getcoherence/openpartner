/**
 * Tenant RLS policies stay plain `"tenantId" = app.tenant_id` equality.
 *
 * An OR in a policy (the retired `app.platform_admin` override) keeps the
 * planner from using a tenant-leading index for every query that leaves
 * tenant scoping to RLS, so each lookup scans all tenants' rows. Migration
 * 20261017100000_rls_plain_tenant_policies removed the OR; these tests fail
 * if a later migration copies the old policy template back in.
 *
 * The plan check runs as openpartner_app and is skipped where that role
 * isn't provisioned (same gate as multi-tenant.test.ts).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TABLES } from '@openpartner/db';

const { db } = await import('../db.js');

const skipIntegration = !process.env.DATABASE_URL || process.env.INTEGRATION === 'skip';

let appRoleAvailable = false;

beforeAll(async () => {
  if (skipIntegration) return;
  const role = (await db.raw(
    `select 1 from pg_roles where rolname = 'openpartner_app' and rolcanlogin and not rolbypassrls`,
  )) as { rows: unknown[] };
  appRoleAvailable = role.rows.length > 0;
});

afterAll(async () => {
  await db.destroy();
});

interface PolicyRow {
  tablename: string;
  policyname: string;
  qual: string | null;
  with_check: string | null;
}

interface PlanNode {
  'Index Cond'?: string;
  Plans?: PlanNode[];
}

async function policies(): Promise<PolicyRow[]> {
  const { rows } = (await db.raw(
    `select tablename, policyname, qual, with_check from pg_policies where schemaname = current_schema() order by 1, 2`,
  )) as { rows: PolicyRow[] };
  return rows;
}

describe.skipIf(skipIntegration)('tenant RLS policy shape', () => {
  it('no policy reads app.platform_admin', async () => {
    const offenders = (await policies()).filter((p) => `${p.qual} ${p.with_check}`.includes('platform_admin'));
    expect(offenders.map((p) => `${p.tablename}.${p.policyname}`)).toEqual([]);
  });

  it('no policy ORs anything into its predicate', async () => {
    const offenders = (await policies()).filter((p) => /\bor\b/i.test(`${p.qual ?? ''} ${p.with_check ?? ''}`));
    expect(offenders.map((p) => `${p.tablename}.${p.policyname}: ${p.qual}`)).toEqual([]);
  });

  it('an RLS-only lookup gets the tenant into its index condition', async () => {
    if (!appRoleAvailable) return;
    const plan = await db.transaction(async (trx) => {
      await trx.raw('set local row_security = on');
      await trx.raw('set local role openpartner_app');
      await trx.raw(`set local app.tenant_id = 'default'`);
      // An empty table would seq-scan on cost alone; this asks whether an
      // index *can* carry the tenant predicate, not whether it's cheapest.
      await trx.raw('set local enable_seqscan = off');
      const { rows } = (await trx.raw(`explain (format json) select id from ?? where email = ?`, [
        TABLES.Partner,
        'nobody@example.test',
      ])) as { rows: Array<{ 'QUERY PLAN': Array<{ Plan: PlanNode }> }> };
      return rows[0]!['QUERY PLAN'][0]!.Plan;
    });
    const indexConds: string[] = [];
    (function walk(node: PlanNode) {
      if (node['Index Cond']) indexConds.push(node['Index Cond']);
      node.Plans?.forEach(walk);
    })(plan);
    expect(indexConds.some((c) => c.includes('"tenantId"'))).toBe(true);
  });
});
