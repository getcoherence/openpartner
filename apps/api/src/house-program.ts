/**
 * OpenPartner's own partner program: the hosted tenant whose partners refer
 * brands to OpenPartner itself (the "house program"). Ops picks the tenant
 * in the /platform console (PlatformSetting `houseProgram`); while none is
 * picked nothing here runs.
 *
 * A brand a partner referred is one user in the house tenant, keyed on the
 * brand's own tenant id:
 *   - At signup (POST /signup, POST /me/brands) the partner click the
 *     visitor carries is stitched to that user and a `signup` Event is
 *     recorded (recordHouseSignup). The click comes from the signup page's
 *     own `?cref=` (a partner link straight to /signup), else the `op_ref`
 *     cookie op.js on openpartner.dev writes on the parent domain. The
 *     router's `_cref` cookie is not read: every brand's clicks share it.
 *   - The brand's billing Customer (billing.ts, invoice-billing.ts) names
 *     that user in metadata.openpartner_user_id (houseCustomerMetadata), the
 *     link every connected brand uses. The house tenant's Stripe App
 *     connection to OpenPartner's billing account then records the brand's
 *     subscription and invoices as that user's, and credits the partner,
 *     exactly as for any brand's customers.
 *
 * /webhooks/stripe sees the same Customers as OpenPartner's own billing,
 * resolved to the brand's own tenant, where the id names nobody; it ignores
 * the metadata there (stripe-webhook.ts customerUserId).
 *
 * Only a referred brand leaves a trace: without a house click there is no
 * Identity, no Event and no metadata. Everything here is best-effort and
 * never fails a signup or a checkout.
 */

import type { Knex } from 'knex';
import { TABLES, type ClickRow, type IdentityRow, type PlatformSettingRow } from '@openpartner/db';
import { recordClickConversion } from './conversion-ingest.js';
import { db as platformDb } from './db.js';
import { withTenantTransaction } from './tenancy.js';

export interface HouseProgramSettings {
  /** The tenant that runs OpenPartner's own partner program. */
  tenantId: string | null;
}

const HOUSE_PROGRAM_KEY = 'houseProgram';

/** The referral cookie op.js writes (packages/sdk/src/auto.ts). */
export const HOUSE_REFERRAL_COOKIE = 'op_ref';

/** A click id as the SDK stores it (browser.ts STRIPE_REFERENCE_RE). */
const CREF_RE = /^[A-Za-z0-9_-]{1,200}$/;

export async function getHouseProgramSettings(db: Knex): Promise<HouseProgramSettings> {
  const row = await db<PlatformSettingRow>(TABLES.PlatformSetting).where({ key: HOUSE_PROGRAM_KEY }).first();
  const v = (row?.value ?? {}) as Partial<HouseProgramSettings>;
  return { tenantId: typeof v.tenantId === 'string' && v.tenantId ? v.tenantId : null };
}

export async function setHouseProgramSettings(
  db: Knex,
  next: HouseProgramSettings,
  operatorEmail: string,
): Promise<HouseProgramSettings> {
  const value = { tenantId: next.tenantId };
  await db(TABLES.PlatformSetting)
    .insert({ key: HOUSE_PROGRAM_KEY, value: value as unknown as never, updatedByEmail: operatorEmail, updatedAt: new Date() })
    .onConflict('key')
    .merge({ value: value as unknown as never, updatedByEmail: operatorEmail, updatedAt: new Date() });
  return value;
}

/** The click ids a signup request carries, best first: the signup page's
 *  `?cref=` (sent in the body), then the op_ref cookie. */
export function signupCrefs(bodyCref: unknown, cookies: Record<string, unknown> | undefined): string[] {
  const out: string[] = [];
  for (const v of [bodyCref, cookies?.[HOUSE_REFERRAL_COOKIE]]) {
    if (typeof v === 'string' && CREF_RE.test(v) && !out.includes(v)) out.push(v);
  }
  return out;
}

export type HouseSignupResult =
  | { status: 'recorded' | 'replayed'; eventId: string; clickId: string }
  | { status: 'skipped'; reason: 'no_house_program' | 'no_click' | 'house_tenant' | 'not_recorded' };

/**
 * Credit a new brand's signup to the house program partner whose click the
 * visitor carries. Idempotent on the brand (externalEventId
 * `brand_signup:<tenantId>`), so an abandoned signup reclaimed under the
 * same slug replays rather than recording twice. Never throws.
 */
export async function recordHouseSignup(input: {
  brandTenantId: string;
  brandSlug: string;
  displayName: string;
  crefs: string[];
}): Promise<HouseSignupResult> {
  try {
    if (input.crefs.length === 0) return { status: 'skipped', reason: 'no_click' };
    const { tenantId: houseTenantId } = await getHouseProgramSettings(platformDb);
    if (!houseTenantId) return { status: 'skipped', reason: 'no_house_program' };
    if (houseTenantId === input.brandTenantId) return { status: 'skipped', reason: 'house_tenant' };

    return await withTenantTransaction(houseTenantId, async (trx) => {
      // The first candidate that is one of the house program's own clicks.
      // An op_ref from some other tenant's click names nothing here.
      const found = await trx<ClickRow>(TABLES.Click)
        .where({ tenantId: houseTenantId })
        .whereIn('id', input.crefs)
        .select('id');
      const ids = new Set(found.map((c) => c.id));
      const clickId = input.crefs.find((c) => ids.has(c));
      if (!clickId) return { status: 'skipped', reason: 'no_click' } as const;

      const result = await recordClickConversion(trx, houseTenantId, {
        clickId,
        userId: input.brandTenantId,
        type: 'signup',
        externalEventId: `brand_signup:${input.brandTenantId}`,
        // customerLabel shows only if the house program turns customer
        // labels on for its partners (referrals.ts).
        metadata: { source: 'brand_signup', brandSlug: input.brandSlug, customerLabel: input.displayName },
      });
      if (!result.ok) {
        console.warn('[house-program] signup not recorded', { brandTenantId: input.brandTenantId, error: result.error });
        return { status: 'skipped', reason: 'not_recorded' } as const;
      }
      return { status: result.replayed ? 'replayed' : 'recorded', eventId: result.eventId, clickId } as const;
    });
  } catch (err) {
    console.error('[house-program] signup credit failed', { brandTenantId: input.brandTenantId, err });
    return { status: 'skipped', reason: 'not_recorded' };
  }
}

/**
 * Metadata for a brand's new billing Customer: openpartner_user_id naming
 * the brand in the house program, when a partner referred it there. Empty
 * otherwise, and on any failure: billing never waits on the house program.
 */
export async function houseCustomerMetadata(brandTenantId: string): Promise<{ openpartner_user_id?: string }> {
  try {
    const { tenantId: houseTenantId } = await getHouseProgramSettings(platformDb);
    if (!houseTenantId || houseTenantId === brandTenantId) return {};
    const referred = await withTenantTransaction(houseTenantId, (trx) =>
      trx<IdentityRow>(TABLES.Identity).where({ tenantId: houseTenantId, userId: brandTenantId }).first('id'),
    );
    return referred ? { openpartner_user_id: brandTenantId } : {};
  } catch (err) {
    console.error('[house-program] referral lookup failed', { brandTenantId, err });
    return {};
  }
}
