/**
 * Partner portal access: whether a partner may sign in to the partner
 * portal (Partner.portalAccess).
 *
 * A headless program (docs/headless-referral.md) is the partner's only UI:
 * its customers never meet OpenPartner. Their partners are created with
 * `sendInvite: false`, which makes them active at once, and an active
 * partner could always ask `POST /auth/signin` for a magic link. So anyone
 * who knew a customer's email could make OpenPartner email that customer,
 * and the customer then had the whole hosted portal. With portal access
 * off:
 *
 *   - `POST /auth/signin` sends nothing and answers exactly as it does for
 *     an unknown email, so it can't be used to learn who is a partner;
 *   - a magic link doesn't verify, and existing sessions stop resolving
 *     (auth-sessions.ts resolveSession);
 *   - turning it off ends live sessions and unused links (endPortalAccess);
 *   - no invite can be sent, and no email that points into the portal
 *     (program-ending notices) goes to the partner. A revoke notice is sent
 *     only when the revoke asks for it explicitly.
 *
 * Partner API keys (`POST /partners/{id}/api-keys`) are credentials the
 * brand manages, not the portal, so they are left alone.
 *
 * The tenant default for partners created without an invite lives in
 * Config (`partner_access`), set with `POST /config/partner-access` or on
 * Admin → Settings.
 */

import type { Knex } from 'knex';
import { TABLES, type MagicLinkTokenRow, type SessionRow } from '@openpartner/db';
import { getConfig, setConfig } from './config.js';

export const PARTNER_ACCESS_CONFIG_KEY = 'partner_access';

export interface PartnerAccessSettings {
  /** Portal access for partners added without an invite: `POST /partners`
   *  with `sendInvite: false` (except partners the OpenPartner Network
   *  provisions) and `POST /import/partners-csv`. Default true, which is
   *  how every tenant behaved before the setting existed. */
  uninvitedPortalAccess: boolean;
}

export async function readPartnerAccessSettings(db: Knex, tenantId: string): Promise<PartnerAccessSettings> {
  const value = await getConfig<Partial<PartnerAccessSettings>>(db, tenantId, PARTNER_ACCESS_CONFIG_KEY);
  return { uninvitedPortalAccess: value?.uninvitedPortalAccess !== false };
}

export async function savePartnerAccessSettings(
  db: Knex,
  tenantId: string,
  patch: Partial<PartnerAccessSettings>,
): Promise<PartnerAccessSettings> {
  const current = await readPartnerAccessSettings(db, tenantId);
  const next: PartnerAccessSettings = {
    uninvitedPortalAccess: patch.uninvitedPortalAccess ?? current.uninvitedPortalAccess,
  };
  await setConfig(db, tenantId, PARTNER_ACCESS_CONFIG_KEY, next);
  return next;
}

/**
 * End every way into the portal the partner holds right now: live sessions
 * and magic links not yet used. Called when portal access is turned off,
 * so turning it back on later doesn't revive a session or a link from
 * before. Partner API keys are not touched (see the module comment).
 */
export async function endPortalAccess(db: Knex, tenantId: string, partnerId: string): Promise<void> {
  const now = new Date();
  await db<SessionRow>(TABLES.Session)
    .where({ tenantId, principalKind: 'partner', principalId: partnerId })
    .whereNull('revokedAt')
    .update({ revokedAt: now });
  await db<MagicLinkTokenRow>(TABLES.MagicLinkToken)
    .where({ tenantId, principalKind: 'partner', principalId: partnerId })
    .whereNull('consumedAt')
    .update({ consumedAt: now });
}
