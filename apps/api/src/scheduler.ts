/**
 * In-process scheduler for periodic platform jobs.
 *
 * DO App Platform doesn't have native cron, so for hosted deployments we run
 * jobs in the api process via croner. Self-host customers get the same code
 * — set OPENPARTNER_ENABLE_SCHEDULER=1 to opt in. Off by default so dev,
 * test, and CI runs don't fire scheduled jobs unexpectedly.
 *
 * Jobs:
 *   - usage-report: every day at 03:15 UTC. Per active tenant, aggregates
 *                   attributed GMV since last report and reports to Stripe
 *                   Billing meters.
 *   - payouts:      every Monday at 09:00 UTC. Per active tenant, runs
 *                   runPayouts() to issue Stripe Connect transfers for
 *                   approved commissions.
 *
 * Both jobs are no-ops in selfhost mode for usage-report. Payouts run in
 * every mode (a self-host operator with no approved commissions just gets
 * an empty result).
 *
 * Multi-tenant: each tick iterates active tenants. For each tenant we open
 * an `appDb.transaction` with `app.tenant_id` pinned, so the per-tenant
 * job runs scoped to that tenant's data.
 *
 * Concurrency: croner's `protect: true` ensures a job that's still running
 * when its next tick arrives skips that tick rather than overlapping. This
 * matters most for usage-report on first run after a long downtime.
 */

import { Cron } from 'croner';
import type { Knex } from 'knex';
import { TABLES, type TenantRow } from '@openpartner/db';
import { appDb, db } from './db.js';
import { reportUsageToStripe } from './usage-billing.js';
import { runPayouts } from './payouts.js';
import { drainOutbox, reportNetworkPayoutsToNetwork } from './network-client.js';
import { getMode } from './stripe.js';

interface ScheduledJob {
  name: string;
  cronExpr: string;
  description: string;
  handler: () => Promise<unknown>;
}

/**
 * Run `fn` once per active tenant inside a tenant-scoped appDb transaction.
 * Failures in one tenant don't stop the iteration — each tenant gets its own
 * try/catch and the aggregate result lists per-tenant outcomes.
 */
async function forEachActiveTenant<T>(
  fn: (db: Knex, tenantId: string) => Promise<T>,
): Promise<Array<{ tenantId: string; ok: boolean; result?: T; error?: string }>> {
  const tenants = await db<TenantRow>(TABLES.Tenant).where({ status: 'active' }).select('id');
  const out: Array<{ tenantId: string; ok: boolean; result?: T; error?: string }> = [];
  for (const t of tenants) {
    try {
      const result = await appDb.transaction(async (trx) => {
        await trx.raw(`set local app.tenant_id = '${t.id.replace(/'/g, "''")}'`);
        return fn(trx, t.id);
      });
      out.push({ tenantId: t.id, ok: true, result });
    } catch (err) {
      out.push({ tenantId: t.id, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return out;
}

const JOBS: ScheduledJob[] = [
  {
    name: 'usage-report',
    cronExpr: '15 3 * * *',
    description: 'Per tenant: aggregate attributed GMV and report to Stripe meters (daily 03:15 UTC)',
    handler: async () => {
      if (getMode() === 'selfhost') return { skipped: 'selfhost' };
      return forEachActiveTenant((trx, tenantId) => reportUsageToStripe(trx, tenantId));
    },
  },
  {
    name: 'payouts',
    cronExpr: '0 9 * * 1',
    description: 'Per tenant: issue Stripe Connect transfers for approved commissions (Monday 09:00 UTC)',
    handler: async () => forEachActiveTenant((trx, tenantId) => runPayouts(trx, tenantId)),
  },
  {
    name: 'network-outbox-drain',
    cronExpr: '*/5 * * * *',
    description: 'Per tenant: retry failed Network pushes from NetworkOutbox (every 5 minutes)',
    handler: async () => forEachActiveTenant((trx, tenantId) => drainOutbox(trx, tenantId)),
  },
  {
    name: 'network-payouts-report',
    cronExpr: '30 3 * * *',
    description: 'Per tenant: aggregate Network-originated payout volume + report to the Network for Stripe metering (daily 03:30 UTC)',
    handler: async () =>
      forEachActiveTenant((trx, tenantId) => reportNetworkPayoutsToNetwork(trx, tenantId)),
  },
  {
    name: 'tenant-hard-delete',
    cronExpr: '0 4 * * *',
    description: 'Hard-delete tenants whose 30-day deletion grace window has lapsed (daily 04:00 UTC)',
    handler: async () => hardDeleteExpiredTenants(),
  },
];

/** Cascade-delete tenants whose pendingDeletionAt is older than the
 *  grace window. Runs in the privileged db (we need to bypass RLS to
 *  drop child rows in any tenant's slice). */
async function hardDeleteExpiredTenants(): Promise<{ purged: number; tenantIds: string[] }> {
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const expired = await db<TenantRow>(TABLES.Tenant)
    .where('pendingDeletionAt', '<', cutoff)
    .select('id');
  const tenantIds: string[] = [];
  // Tenanted tables to wipe — order doesn't matter because they're
  // all tagged with tenantId. Tenant row is dropped last.
  const TENANTED_TABLES = [
    TABLES.NetworkOutbox,
    TABLES.WebhookDelivery,
    TABLES.WebhookEndpoint,
    TABLES.Session,
    TABLES.MagicLinkToken,
    TABLES.ApiKey,
    TABLES.Config,
    TABLES.Payout,
    TABLES.Commission,
    TABLES.Attribution,
    TABLES.Event,
    TABLES.Identity,
    TABLES.Click,
    TABLES.Link,
    TABLES.Campaign,
    TABLES.Partner,
    TABLES.Admin,
  ];
  for (const t of expired) {
    try {
      await db.transaction(async (trx) => {
        for (const tbl of TENANTED_TABLES) {
          await trx(tbl).where({ tenantId: t.id }).del();
        }
        await trx<TenantRow>(TABLES.Tenant).where({ id: t.id }).del();
      });
      tenantIds.push(t.id);
    } catch (err) {
      console.error('[scheduler] hard-delete failed', { tenantId: t.id, err });
    }
  }
  return { purged: tenantIds.length, tenantIds };
}

let started = false;
const handles: Cron[] = [];

export function startScheduler(): void {
  if (started) return;
  if (process.env.OPENPARTNER_ENABLE_SCHEDULER !== '1') {
    console.log('[scheduler] disabled (set OPENPARTNER_ENABLE_SCHEDULER=1 to enable)');
    return;
  }

  for (const job of JOBS) {
    const handle = new Cron(
      job.cronExpr,
      { name: job.name, timezone: 'UTC', protect: true },
      async () => {
        const start = Date.now();
        // pg advisory lock keyed off the job name — guarantees only one
        // process across the whole cluster runs the body, even if the
        // app scales to multiple instances. Two-int form to match the
        // 64-bit signature; use a stable hash of the name so the same
        // job always lands on the same key.
        const [classId, objId] = lockKeyForJob(job.name);
        const trx = await db.transaction();
        let acquired = false;
        try {
          const r = (await trx.raw('select pg_try_advisory_xact_lock(?, ?) as locked', [classId, objId])) as {
            rows: Array<{ locked: boolean }>;
          };
          acquired = !!r.rows[0]?.locked;
          if (!acquired) {
            console.log(`[scheduler] ${job.name} skipped — another instance holds the lock`);
            await trx.rollback();
            return;
          }
          console.log(`[scheduler] ${job.name} starting`);
          const result = await job.handler();
          await trx.commit();
          console.log(`[scheduler] ${job.name} finished in ${Date.now() - start}ms`, result);
        } catch (err) {
          await trx.rollback().catch(() => {});
          console.error(`[scheduler] ${job.name} failed`, err);
        }
      },
    );
    handles.push(handle);
    console.log(`[scheduler] registered ${job.name} (${job.cronExpr}) — ${job.description}`);
  }
  started = true;
}

/** Stable two-int advisory-lock key for a job name. The xact-scoped
 *  variant releases on commit/rollback, so we don't need explicit
 *  unlock. Class id is fixed so all our scheduler locks share a
 *  namespace. */
function lockKeyForJob(name: string): [number, number] {
  let h = 0;
  for (let i = 0; i < name.length; i += 1) h = ((h << 5) - h + name.charCodeAt(i)) | 0;
  // 0x534F503F = 'SCHED' magic-ish — any constant works as long as it
  // doesn't collide with another locker on the same DB.
  return [0x534f503f, h];
}

export function stopScheduler(): void {
  for (const h of handles) h.stop();
  handles.length = 0;
  started = false;
}
