/**
 * Password and Google sign-in end where an emailed link begins.
 *
 * Once a password or a Google ID token has proven the address, we issue the
 * very token the sign-in email would have carried and hand it to the
 * browser instead of mailing it: a password route returns it for the SPA to
 * POST to the verify endpoint, the Google callback redirects to the landing
 * URL the email would have linked. Sessions, bundles, activation, and the
 * review / portal-access / country checks all stay in the verify endpoints,
 * so the new ways in can't drift from the audited one.
 *
 * Who may get a token here is exactly who /signin, /auth/signin and
 * /platform-admin/signin would mail one to.
 */

import type { Knex } from 'knex';
import { DEFAULT_TENANT_ID, TABLES, type AdminRow, type PartnerRow } from '@openpartner/db';
import { issueMagicLink } from './auth-sessions.js';

/** Platform identity (brand admin, multi-tenant). `add` stacks it onto the
 *  browser's existing identity bundle instead of replacing it. Takes the
 *  privileged pool — platform tokens aren't tenant-scoped. */
export async function platformSigninToken(db: Knex, email: string, add: boolean): Promise<string> {
  const address = email.toLowerCase();
  const issued = await issueMagicLink(db, {
    tenantId: DEFAULT_TENANT_ID, // placeholder, as in /signin
    email: address,
    purpose: add ? 'platform_add_account' : 'platform_signin',
    principalKind: 'platform',
    principalId: address,
  });
  return issued.plaintext;
}

/** Ops console. The caller has already checked isAllowedOperator. */
export async function opsSigninToken(db: Knex, email: string): Promise<string> {
  const address = email.toLowerCase();
  const issued = await issueMagicLink(db, {
    tenantId: DEFAULT_TENANT_ID,
    email: address,
    purpose: 'platform_admin_signin',
    principalKind: 'platform',
    principalId: address,
  });
  return issued.plaintext;
}

export interface TenantSigninCandidates {
  /** Activated, not revoked — the admins /auth/signin mails. */
  admin: AdminRow | null;
  /** Activated, not revoked, portal access on — the partners /auth/signin
   *  mails. Applicants held for review aren't activated, so never here. */
  partner: PartnerRow | null;
}

/** Both lookups name the tenant: a pool that bypasses RLS would otherwise
 *  find another brand's admin or partner. */
export async function tenantSigninCandidates(db: Knex, tenantId: string, email: string): Promise<TenantSigninCandidates> {
  const address = email.toLowerCase();
  const admin = await db<AdminRow>(TABLES.Admin).where({ tenantId, email: address }).first();
  const partner = await db<PartnerRow>(TABLES.Partner).where({ tenantId, email: address }).first();
  return {
    admin: admin?.activatedAt && !admin.revokedAt ? admin : null,
    partner: partner?.activatedAt && !partner.revokedAt && partner.portalAccess ? partner : null,
  };
}

export type TenantSigninPrincipal = { kind: 'admin'; row: AdminRow } | { kind: 'partner'; row: PartnerRow };

export async function tenantSigninToken(db: Knex, tenantId: string, principal: TenantSigninPrincipal): Promise<string> {
  const issued = await issueMagicLink(db, {
    tenantId,
    email: principal.row.email.toLowerCase(),
    purpose: principal.kind === 'admin' ? 'admin_signin' : 'partner_signin',
    principalKind: principal.kind,
    principalId: principal.row.id,
  });
  return issued.plaintext;
}
