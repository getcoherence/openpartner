/**
 * Deleting a program nothing uses yet (DELETE /programs/:id): a duplicate,
 * or one made by mistake.
 *
 * A program goes only while no row names it: no partner grant, link,
 * click, coupon, conversion, commission terms, bonus, bounty or test click.
 * So no raw click/identity/event data ever goes with it (CLAUDE.md
 * principle 1); a program with any history is ended (endsAt) instead. Four
 * of those tables cascade on delete and three refuse it, and Click and
 * Attribution have no foreign key at all, so every one is checked rather
 * than trusting the constraints.
 */

import type { Knex } from 'knex';
import { TABLES } from '@openpartner/db';
import { networkProxy, NetworkProxyError } from './network-client.js';

/** Every table with a programId column, and what its rows are to a brand.
 *  Attribution last: it has no programId index, and an attribution's click
 *  is in the same program, so a used program rarely gets that far. */
const PROGRAM_REFERENCES = [
  { table: TABLES.PartnerProgram, label: 'partners' },
  { table: TABLES.Link, label: 'links' },
  { table: TABLES.Click, label: 'clicks' },
  { table: TABLES.Coupon, label: 'coupons' },
  { table: TABLES.PartnerCommission, label: 'partner commission terms' },
  { table: TABLES.Bonus, label: 'bonuses' },
  { table: TABLES.Bounty, label: 'bounties' },
  { table: TABLES.TestClick, label: 'test clicks' },
  { table: TABLES.Attribution, label: 'conversions' },
] as const;

function referencedSql(table: string): string {
  const p = `"${TABLES.Program}"`;
  return `exists (select 1 from "${table}" r where r."programId" = ${p}.id and r."tenantId" = ${p}."tenantId")`;
}

/** True when some row names the program, as a select expression over
 *  Program. Postgres stops at the first table that does. */
export const PROGRAM_IN_USE_SQL = `(${PROGRAM_REFERENCES.map((r) => referencedSql(r.table)).join(' or ')})`;

/** What uses this program, in PROGRAM_REFERENCES' words; empty when
 *  nothing does and it can be deleted. */
export async function programUses(db: Knex, tenantId: string, programId: string): Promise<string[]> {
  const columns = PROGRAM_REFERENCES.map((r, i) => `${referencedSql(r.table)} as "r${i}"`).join(', ');
  const { rows } = (await db.raw(
    `select ${columns} from "${TABLES.Program}" where id = ? and "tenantId" = ?`,
    [programId, tenantId],
  )) as { rows: Array<Record<string, boolean>> };
  const row = rows[0];
  if (!row) return [];
  return PROGRAM_REFERENCES.filter((_, i) => row[`r${i}`]).map((r) => r.label);
}

/**
 * Take the program's Network offering down before the program goes, so
 * the marketplace never lists a program that no longer exists. The Network
 * deletes the offering, or only unpublishes it while a creator partnership
 * names it. If that call fails, unpublishing (what campaign-marketplace-sync
 * does for a program taken off the Network) is enough, and an offering the
 * Network no longer has is already down.
 *
 * Throws NetworkProxyError when the offering may still be listed: the
 * program has to stay then.
 */
export async function takeDownNetworkOffering(db: Knex, tenantId: string, offeringId: string): Promise<void> {
  try {
    await networkProxy.deleteOffering(db, tenantId, offeringId);
    return;
  } catch (err) {
    if (!(err instanceof NetworkProxyError)) throw err;
    console.error('[program-deletion] offering delete failed, unpublishing instead', {
      offeringId,
      detail: `${err.status} ${err.message}`,
    });
  }
  try {
    await networkProxy.updateOffering(db, tenantId, offeringId, { published: false });
  } catch (err) {
    if (err instanceof NetworkProxyError && err.status === 404) return;
    throw err;
  }
}
