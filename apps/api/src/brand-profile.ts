/**
 * The brand's own promoter profile on the Network (docs/network-protocol.md;
 * the Network's docs/brand-profiles.md has the rules).
 *
 * A brand can join another brand's program the way a creator does, without
 * anyone on its team registering a creator account or leaving this portal.
 * The Network keeps the profile (a Creator of kind 'brand', owned by this
 * brand's vendor). This side decides who may create it and with which
 * address, and works it for whichever admin is signed in: the Promote
 * pages call the Network's creator routes as the profile, through
 * /admin/network/promoter-api (routes/settings.ts,
 * network-client.ts callNetworkAsBrandProfile). There is no sign-in to it.
 *
 * The address is the partner email on every brand the profile joins: links
 * to those brands' partner portals, where payout details are set, go to it.
 * So it has to be a mailbox this brand has proven it reads, which here
 * means the address of one of its own activated full admins. It can't be
 * changed afterwards (the Network has no change-of-address flow).
 *
 * Nothing is stored here: the profile lives on the Network and is read
 * through the brand's vendor token, so there is nothing to export or
 * migrate on this side.
 */

import type { Knex } from 'knex';
import { TABLES, type AdminRow, type ProgramRow } from '@openpartner/db';
import { db as platformDb } from './db.js';
import { latestDeclaredCountries } from './country-access.js';
import { getTenancyMode } from './tenancy.js';

export interface BrandProfileContact {
  email: string;
  name: string;
}

/** The addresses a brand profile may be created with: this brand's
 *  activated, unrevoked full admins. View-only seats don't count. */
export async function brandProfileContacts(db: Knex, tenantId: string): Promise<BrandProfileContact[]> {
  const rows = (await db<AdminRow>(TABLES.Admin)
    .where({ tenantId, role: 'admin' })
    .whereNotNull('activatedAt')
    .whereNull('revokedAt')
    .orderBy('createdAt', 'asc')
    .select('email', 'name')) as Array<Pick<AdminRow, 'email' | 'name'>>;
  return rows.map((r) => ({ email: r.email.toLowerCase(), name: r.name }));
}

/** The brand's site, guessed from where its oldest program sends
 *  visitors. The admin can change or clear it before the profile is made. */
export async function suggestedWebsite(db: Knex, tenantId: string): Promise<string | null> {
  const program = (await db<ProgramRow>(TABLES.Program)
    .where({ tenantId })
    .whereNotNull('destinationUrl')
    .orderBy('createdAt', 'asc')
    .first('destinationUrl')) as Pick<ProgramRow, 'destinationUrl'> | undefined;
  if (!program?.destinationUrl) return null;
  try {
    const url = new URL(program.destinationUrl);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : null;
  } catch {
    return null;
  }
}

/** Where the brand said it is based, for the profile's own declaration on
 *  the Network. Single-tenant installs never ask, and send none. */
export async function brandDeclaredLocation(
  tenantId: string,
): Promise<{ country: string; outsideOccupiedRegions?: boolean } | null> {
  if (getTenancyMode() !== 'multi') return null;
  // LocationDeclaration is a platform table: read on the privileged pool,
  // always filtered to this tenant.
  const latest = (await latestDeclaredCountries(platformDb, 'tenant', [tenantId])).get(tenantId);
  if (!latest) return null;
  return {
    country: latest.country,
    ...(latest.outsideOccupiedRegions === null ? {} : { outsideOccupiedRegions: latest.outsideOccupiedRegions }),
  };
}

/** The Network's refusal code inside a proxy error, if it sent one. */
export function networkErrorCode(message: string): string | null {
  try {
    const code = (JSON.parse(message) as { error?: unknown }).error;
    return typeof code === 'string' ? code : null;
  } catch {
    return null;
  }
}
