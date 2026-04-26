/**
 * In-process scheduler for periodic platform jobs.
 *
 * DO App Platform doesn't have native cron, so for hosted deployments we run
 * jobs in the api process via croner. Self-host customers get the same code
 * — set OPENPARTNER_ENABLE_SCHEDULER=1 to opt in. Off by default so dev,
 * test, and CI runs don't fire scheduled jobs unexpectedly.
 *
 * Jobs:
 *   - usage-report: every day at 03:15 UTC. Aggregates attributed GMV since
 *                   last report and reports to Stripe Billing meters.
 *   - payouts:      every Monday at 09:00 UTC. Runs runPayouts() to issue
 *                   Stripe Connect transfers for approved commissions.
 *
 * Both jobs are no-ops in selfhost mode — usage reporting requires a Stripe
 * subscription, and payouts only run when there are approved commissions.
 *
 * Concurrency: croner's `protect: true` ensures a job that's still running
 * when its next tick arrives skips that tick rather than overlapping. This
 * matters most for usage-report on first run after a long downtime.
 */

import { Cron } from 'croner';
import { reportUsageToStripe } from './usage-billing.js';
import { runPayouts } from './payouts.js';
import { getMode } from './stripe.js';

interface ScheduledJob {
  name: string;
  cronExpr: string;
  description: string;
  handler: () => Promise<unknown>;
}

const JOBS: ScheduledJob[] = [
  {
    name: 'usage-report',
    cronExpr: '15 3 * * *',
    description: 'Aggregate attributed GMV and report to Stripe meters (daily 03:15 UTC)',
    handler: async () => {
      if (getMode() === 'selfhost') return { skipped: 'selfhost' };
      return reportUsageToStripe();
    },
  },
  {
    name: 'payouts',
    cronExpr: '0 9 * * 1',
    description: 'Issue Stripe Connect transfers for approved commissions (Monday 09:00 UTC)',
    handler: async () => runPayouts(),
  },
];

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
        console.log(`[scheduler] ${job.name} starting`);
        try {
          const result = await job.handler();
          console.log(`[scheduler] ${job.name} finished in ${Date.now() - start}ms`, result);
        } catch (err) {
          console.error(`[scheduler] ${job.name} failed`, err);
        }
      },
    );
    handles.push(handle);
    console.log(`[scheduler] registered ${job.name} (${job.cronExpr}) — ${job.description}`);
  }
  started = true;
}

export function stopScheduler(): void {
  for (const h of handles) h.stop();
  handles.length = 0;
  started = false;
}
