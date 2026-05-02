/**
 * Auto-approve accrued commissions whose holdback has elapsed.
 *
 * Scoped per-tenant. Only acts on commissions whose Campaign has
 * holdbackDays > 0 — campaigns with null/0 holdback continue to
 * require manual approval (no behavior change for legacy / opted-out
 * brands). The job is safe to re-run; the WHERE clause is the source
 * of truth and a no-op once everything's been swept.
 */

import type { Knex } from 'knex';
import { TABLES } from '@openpartner/db';

export interface AutoApproveResult {
  approvedCount: number;
}

export async function autoApproveMatureCommissions(
  db: Knex,
): Promise<AutoApproveResult> {
  // Find every accrued commission whose campaign has a holdback set
  // AND whose accruedAt + holdbackDays days has elapsed. Postgres
  // INTERVAL math via raw because knex can't construct the dynamic
  // interval expression cleanly.
  //
  // We update in a single statement so two scheduler ticks racing
  // don't double-process the same row — UPDATE is atomic against the
  // WHERE filter.
  const result = (await db.raw(
    `
    update "${TABLES.Commission}" c
       set status = 'approved'
      from "${TABLES.Attribution}" a, "${TABLES.Campaign}" cp
     where c.status = 'accrued'
       and c."attributionId" = a.id
       and a."campaignId" = cp.id
       and cp."holdbackDays" is not null
       and cp."holdbackDays" > 0
       and c."accruedAt" + (cp."holdbackDays" * interval '1 day') <= now()
    returning c.id
    `,
  )) as { rows: Array<{ id: string }> };

  return { approvedCount: result.rows.length };
}
