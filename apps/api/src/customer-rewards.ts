/**
 * Customer-side reward provisioning (dual-sided incentives, Path A).
 *
 * When a Campaign has a customerReward configured, every Coupon minted
 * for that Campaign gets a matching Stripe Coupon + PromotionCode so the
 * customer's discount applies automatically when they enter the code at
 * the brand's checkout.
 *
 * Rewards are only ever provisioned in the BRAND's own Stripe account —
 * see rewardStripe(). On hosted deployments that's the account the brand
 * connected through the OpenPartner Stripe App; without one, provisioning
 * is skipped and the stripe ids stay null.
 *
 * Failures are non-fatal: if Stripe isn't configured, or the API call
 * fails, the Coupon row is still written and stripeCouponId stays null.
 * The partner attribution path (POST /coupons/redeem) is independent of
 * Stripe and continues to work — the customer just doesn't get the
 * discount auto-applied.
 *
 * On hosted, codes that missed their promotion code get one later:
 * connecting Stripe backfills every active code (backfillCustomerRewards),
 * and an hourly sweep retries what's still missing. Codes are minted when a
 * partner is granted a program, usually before the brand connects.
 */

import type Stripe from 'stripe';
import type { Knex } from 'knex';
import { TABLES, type CustomerReward } from '@openpartner/db';
import { getMode, stripe } from './stripe.js';
import { toStripeMinor } from './stripe-amounts.js';
import {
  activeConnectionForTenant,
  brandRewardsTarget,
  brandStripeForRewards,
  markRewardsVerified,
  rewardConnections,
  stripeAppRewardsAvailable,
} from './stripe-app.js';
import { getTenancyMode, withTenantTransaction } from './tenancy.js';

export interface ProvisionedReward {
  stripeCouponId: string;
  stripePromotionCodeId: string;
}

/**
 * The Stripe client a tenant's customer rewards are provisioned in: the
 * brand's own account, or null when this deployment has no way to reach it.
 *
 *   - Single-tenant self-host: STRIPE_SECRET_KEY IS the brand's key.
 *   - Hosted (flat / revshare): the account the brand connected through
 *     the OpenPartner Stripe App, when the connection is healthy and grants
 *     coupon + promotion-code writes (stripe-app.ts brandStripeForRewards).
 *     NEVER STRIPE_SECRET_KEY there: that's OpenPartner's own billing
 *     account, whose plan Checkout runs with allow_promotion_codes — a
 *     reward minted there would be redeemable against OpenPartner's plans,
 *     would never exist at the brand's checkout, and would share one code
 *     namespace across every tenant.
 *   - Multi-tenant self-host: one key, many brands — nothing to reach.
 *
 * Partner.stripeConnectAccountId is a payout destination, not the brand,
 * and is never used here.
 */
export async function rewardStripe(tenantId: string): Promise<Stripe | null> {
  if (getMode() === 'selfhost') return getTenancyMode() === 'single' ? stripe : null;
  return brandStripeForRewards(tenantId);
}

/**
 * Does `code` already exist in the brand's Stripe account as a promotion
 * code (active or not — inactive promos still ride on live subscriptions'
 * invoices) or as a coupon id (the webhook falls back to coupon.id when a
 * discount has no promotion code)?
 *
 * Coupon redemption matches on the code string alone, so a partner coupon
 * that shadows a brand promo like WELCOME10 would be credited with every
 * order using it. Callers refuse such codes unless the brand's admin chose
 * the code deliberately.
 *
 * Coupon ids are case-sensitive in Stripe while our match is not; we check
 * the code as given and lowercased, which covers the common spellings but
 * not arbitrary mixed case.
 *
 * Returns false when there's no Stripe target (nothing to collide with).
 * Throws on Stripe errors — the caller picks fail-open or fail-closed.
 */
export async function codeExistsInStripe(tenantId: string, code: string): Promise<boolean> {
  const client = await rewardStripe(tenantId);
  if (!client) return false;

  const promos = await client.promotionCodes.list({ code, limit: 1 });
  if (promos.data.length > 0) return true;
  return isCouponId(client, code);
}

/** Is `code` (as given, or lowercased) the id of a Stripe Coupon in this
 *  account? Ours get Stripe-generated ids, so a hit is the brand's own. */
async function isCouponId(client: Stripe, code: string): Promise<boolean> {
  for (const id of new Set([code, code.toLowerCase()])) {
    try {
      await client.coupons.retrieve(id);
      return true;
    } catch (err) {
      if ((err as { code?: string }).code === 'resource_missing') continue;
      throw err;
    }
  }
  return false;
}

/**
 * Provision a Stripe Coupon + PromotionCode for the (campaign, code)
 * pair. Returns null when Stripe isn't configured OR the API call fails
 * — caller should still write the OpenPartner Coupon row and leave the
 * Stripe ID columns null. Logs the error; doesn't throw.
 *
 * couponName surfaces in Stripe Dashboard ("OpenPartner — KEITH15A2X")
 * so the brand can audit which OpenPartner-managed coupons exist
 * without cross-referencing IDs.
 */
export async function provisionCustomerReward(
  tenantId: string,
  reward: CustomerReward,
  code: string,
  campaignName: string,
): Promise<ProvisionedReward | null> {
  const couponParams = toStripeCouponParams(reward, rewardCouponName(campaignName, code));
  if (!couponParams) return null;

  try {
    // Inside the try: on hosted, reaching the brand's account can need a
    // token refresh, and a failed one must not fail the mint.
    const client = await rewardStripe(tenantId);
    if (!client) return null;
    return await createReward(client, couponParams, code);
  } catch (err) {
    console.error('[customer-rewards] Stripe provisioning failed', { code, err });
    return null;
  }
}

function rewardCouponName(campaignName: string, code: string): string {
  return `OpenPartner — ${campaignName} (${code})`;
}

/** The Coupon, then its PromotionCode. The promo's metadata is how a
 *  backfill recognises it as ours (findCodeInStripe). Throws. */
async function createReward(
  client: Stripe,
  couponParams: Stripe.CouponCreateParams,
  code: string,
): Promise<ProvisionedReward> {
  const coupon = await client.coupons.create(couponParams);
  const promo = await client.promotionCodes.create({
    promotion: { type: 'coupon', coupon: coupon.id },
    code,
    metadata: { source: 'openpartner', openpartner_code: code },
  });
  return { stripeCouponId: coupon.id, stripePromotionCodeId: promo.id };
}

/**
 * Disable a Stripe PromotionCode so customers entering the string at
 * checkout get "promotion code is no longer valid" instead of a discount.
 * Used by the coupon-deactivate flow (partner retiring an old code), and
 * to release a promo whose Coupon row then failed to insert.
 *
 * We deactivate the PromotionCode but leave the parent Coupon alone:
 * Stripe rejects coupon deletion once redemptions exist, and the cost of
 * an orphan inactive coupon in Stripe is zero — historical receipts +
 * dashboard redemption records all reference the parent. Cheaper to leak
 * a dormant Coupon than to chase delete failures.
 *
 * Best-effort: failures log but don't throw. The OpenPartner side has
 * already flipped its own deactivatedAt flag when this is called, and
 * an OpenPartner-deactivated code without Stripe deactivation just
 * means the customer gets the discount but the redemption doesn't
 * attribute (the OpenPartner Coupon lookup excludes deactivated rows).
 */
export async function deactivateCustomerReward(tenantId: string, stripePromotionCodeId: string): Promise<void> {
  try {
    const client = await rewardStripe(tenantId);
    if (!client) return;
    await client.promotionCodes.update(stripePromotionCodeId, { active: false });
  } catch (err) {
    console.error('[customer-rewards] deactivate promo failed', { stripePromotionCodeId, err });
  }
}

/**
 * Translate the OpenPartner CustomerReward shape to Stripe's CouponCreateParams.
 *
 * Returns null when the reward is malformed (e.g., amount_off without currency,
 * repeating without durationInMonths). Caller treats null as "skip provisioning".
 *
 * free_months is delivered as percent_off=100 + duration='repeating' +
 * duration_in_months=value — Stripe doesn't have a native "free months" type,
 * but a 100% repeating discount produces the same customer experience.
 */
function toStripeCouponParams(
  reward: CustomerReward,
  name: string,
): Stripe.CouponCreateParams | null {
  const base: Stripe.CouponCreateParams = { name, metadata: { source: 'openpartner' } };

  if (reward.type === 'free_months') {
    if (reward.value <= 0) return null;
    return {
      ...base,
      percent_off: 100,
      duration: 'repeating',
      duration_in_months: reward.value,
    };
  }

  if (reward.type === 'percent_off') {
    return {
      ...base,
      percent_off: reward.value,
      ...durationParams(reward),
    };
  }

  // amount_off
  if (!reward.currency) return null;
  return {
    ...base,
    amount_off: toStripeMinor(reward.value, reward.currency),
    currency: reward.currency.toLowerCase(),
    ...durationParams(reward),
  };
}

function durationParams(
  reward: CustomerReward,
): Pick<Stripe.CouponCreateParams, 'duration' | 'duration_in_months'> {
  if (reward.duration === 'repeating') {
    if (!reward.durationInMonths || reward.durationInMonths <= 0) {
      // Fall back to 'once' rather than throwing — the call site treats null
      // as "skip provisioning" but here the duration field shape is wrong;
      // safer to apply a one-shot discount than no discount at all.
      return { duration: 'once' };
    }
    return { duration: 'repeating', duration_in_months: reward.durationInMonths };
  }
  return { duration: reward.duration };
}

/**
 * How a Program's customerReward reaches the customer on this
 * deployment. The admin Programs page words the reward editor from it,
 * so keep it in step with the provisioning gate in this file.
 *
 *   stripe        each partner code gets its own Stripe Coupon +
 *                 PromotionCode in the brand's account: a single-tenant
 *                 self-host with STRIPE_SECRET_KEY set (that key IS the
 *                 brand's), or a hosted brand whose Stripe App connection
 *                 is healthy and grants the writes.
 *   unconfigured  single-tenant self-host without a Stripe key: nothing
 *                 is provisioned until one is set.
 *   brand         hosted without a usable connection, or multi-tenant
 *                 self-host: our key isn't the brand's, so the brand
 *                 creates the matching discount in its own Stripe or
 *                 checkout.
 *
 * Attribution doesn't depend on this — POST /coupons/redeem matches on
 * the code string alone.
 */
export type CustomerRewardDelivery = 'stripe' | 'unconfigured' | 'brand';

export async function customerRewardDelivery(tenantId: string): Promise<CustomerRewardDelivery> {
  if (getMode() === 'selfhost') {
    if (getTenancyMode() !== 'single') return 'brand';
    return stripe ? 'stripe' : 'unconfigured';
  }
  return (await stripeAppRewardsAvailable(tenantId)) ? 'stripe' : 'brand';
}

// ---------------------------------------------------------------------------
// Backfill — codes whose promotion code isn't in the brand's Stripe
// ---------------------------------------------------------------------------

/** What one pass did, per code. `taken` and `failed` codes keep a null
 *  stripePromotionCodeId, so rewardCodesNotInStripe counts them. */
export interface RewardBackfillResult {
  checked: number;
  /** Its promotion code is already in the connected account. */
  present: number;
  /** One of our promotion codes for it was already there (a pass whose
   *  write didn't land, or a previous connection to this account): recorded,
   *  not created again. */
  linked: number;
  /** Coupon + promotion code created. */
  provisioned: number;
  /** The brand's own promotion code or coupon id has this string: left
   *  alone and logged. */
  taken: number;
  /** Stripe refused this code, or the program's reward is malformed. */
  failed: number;
  /** Deactivated, recorded by another pass, or its connection replaced,
   *  while this one ran. */
  skipped: number;
  /** Another account's promo id removed from a code that gets no new one
   *  now: its partner is suspended, or its program has no customer reward. */
  cleared: number;
  /** Why the pass ended early, leaving the rest to the next one: the
   *  connection went away, or Stripe failed in a way that isn't about one
   *  code (auth, permission, rate limit, outage). */
  stopped: string | null;
  /** Every code was checked against one connection's account, which is now
   *  marked verified (verifyExisting passes on hosted only). */
  verified: boolean;
}

interface RewardCodeRow {
  id: string;
  code: string;
  stripePromotionCodeId: string | null;
  brandChosen: boolean;
  programName: string;
  customerReward: CustomerReward | null;
  partnerRevokedAt: Date | null;
}

/** Active codes of the tenant, with their program and partner. */
function activeCodes(knex: Knex, tenantId: string) {
  return knex(TABLES.Coupon)
    .join(TABLES.Program, function () {
      this.on(`${TABLES.Program}.id`, '=', `${TABLES.Coupon}.programId`).andOn(
        `${TABLES.Program}.tenantId`,
        '=',
        `${TABLES.Coupon}.tenantId`,
      );
    })
    .join(TABLES.Partner, function () {
      this.on(`${TABLES.Partner}.id`, '=', `${TABLES.Coupon}.partnerId`).andOn(
        `${TABLES.Partner}.tenantId`,
        '=',
        `${TABLES.Coupon}.tenantId`,
      );
    })
    .where(`${TABLES.Coupon}.tenantId`, tenantId)
    .whereNull(`${TABLES.Coupon}.deactivatedAt`);
}

/** Codes a customer discount should exist for: on a program with a
 *  customer reward, held by a partner who isn't suspended. */
function onRewardTerms(q: Knex.QueryBuilder): Knex.QueryBuilder {
  return q.whereNotNull(`${TABLES.Program}.customerReward`).whereNull(`${TABLES.Partner}.revokedAt`);
}

function rewardCodes(knex: Knex, tenantId: string) {
  return onRewardTerms(activeCodes(knex, tenantId));
}

/** How many reward codes have no promotion code yet: the Integrations
 *  card's honest count. Codes holding another account's promo id aren't
 *  counted until a verifying pass finds them missing and clears them; the
 *  card says "checking" until the connection is verified. */
export async function rewardCodesNotInStripe(knex: Knex, tenantId: string): Promise<number> {
  const [row] = (await rewardCodes(knex, tenantId)
    .whereNull(`${TABLES.Coupon}.stripePromotionCodeId`)
    .count({ count: `${TABLES.Coupon}.id` })) as Array<{ count: string | number }>;
  return Number(row?.count ?? 0);
}

/**
 * Give every reward code its promotion code in the brand's Stripe account
 * (rewardStripe). Safe to run any number of times, in any number of
 * processes: a code whose promo is there already is left alone, one of ours
 * found by its code string is recorded rather than created twice, and a
 * code the brand owns is never touched.
 *
 * `verifyExisting` (a connect's pass, or the sweep while the connection
 * isn't verified yet) also checks every active code that HAS a promo id: it
 * may belong to another account (a previous connection, live vs. test mode,
 * a self-host's key, or OpenPartner's own billing account before #97). One
 * that's missing here is cleared, then provisioned like a code without one
 * if the code is on reward terms (onRewardTerms). The old promo stays in
 * the old account, out of reach. A pass that checks
 * every code against one connection marks it verified
 * (TenantStripeConnection.rewardsVerifiedAt); until then the hourly sweep
 * runs the check again.
 *
 * Stripe is reached afresh for each code, so a disconnect or a withdrawn
 * write permission stops the pass at the next one. On hosted, an id is only
 * recorded while the connection it was created or found through is still
 * live (recordReward): a pass that outlives a reconnect can't write the old
 * account's ids under the new one.
 */
export async function backfillCustomerRewards(
  tenantId: string,
  opts: { verifyExisting: boolean },
): Promise<RewardBackfillResult> {
  const result: RewardBackfillResult = {
    checked: 0,
    present: 0,
    linked: 0,
    provisioned: 0,
    taken: 0,
    failed: 0,
    skipped: 0,
    cleared: 0,
    stopped: null,
    verified: false,
  };
  // Read before the codes: a reconnect after this point gets a new row (or
  // clears the mark on this one), so marking this id can't vouch for it.
  const startConnection =
    opts.verifyExisting && getMode() !== 'selfhost'
      ? await withTenantTransaction(tenantId, (trx) => activeConnectionForTenant(trx, tenantId))
      : null;
  const rows = await withTenantTransaction(tenantId, async (trx) => {
    const q = activeCodes(trx, tenantId)
      .orderBy(`${TABLES.Coupon}.createdAt`, 'asc')
      .select(
        `${TABLES.Coupon}.id`,
        `${TABLES.Coupon}.code`,
        `${TABLES.Coupon}.stripePromotionCodeId`,
        `${TABLES.Coupon}.brandChosen`,
        `${TABLES.Program}.name as programName`,
        `${TABLES.Program}.customerReward`,
        `${TABLES.Partner}.revokedAt as partnerRevokedAt`,
      );
    if (opts.verifyExisting) {
      // Every code holding a promo id is checked, even one that gets no new
      // promo now (a suspended partner, a reward switched off): reinstated or
      // switched back on, it mustn't keep another account's id unchecked.
      q.where((b) => {
        b.whereNotNull(`${TABLES.Coupon}.stripePromotionCodeId`).orWhere((c) => {
          onRewardTerms(c);
        });
      });
    } else {
      onRewardTerms(q).whereNull(`${TABLES.Coupon}.stripePromotionCodeId`);
    }
    return (await q) as RewardCodeRow[];
  });

  let oneConnection = true;
  for (const row of rows) {
    let target: RewardTarget | null;
    try {
      target = await rewardTarget(tenantId);
    } catch (err) {
      console.error('[customer-rewards] backfill: reaching the brand’s Stripe failed', { tenantId, err });
      result.stopped = 'stripe_unreachable';
      break;
    }
    if (!target) {
      result.stopped = 'no_connection';
      break;
    }
    if (target.connectionId !== (startConnection?.id ?? null)) oneConnection = false;
    result.checked++;
    try {
      result[await backfillCode(target, tenantId, row)]++;
    } catch (err) {
      const type = (err as { type?: string }).type;
      console.error('[customer-rewards] backfill: Stripe provisioning failed', { tenantId, code: row.code, err });
      result.failed++;
      // A bad request is about this code; anything else would fail the rest.
      if (type !== 'StripeInvalidRequestError') {
        result.stopped = type ?? 'error';
        break;
      }
    }
  }

  if (startConnection && !result.stopped && oneConnection) {
    result.verified = await withTenantTransaction(tenantId, (trx) => markRewardsVerified(trx, startConnection.id, tenantId));
  }
  return result;
}

/** Where a tenant's rewards go: rewardStripe's client, plus the Stripe App
 *  connection it acts through on hosted (null on a self-host, whose key
 *  doesn't change under a pass). */
interface RewardTarget {
  client: Stripe;
  connectionId: string | null;
}

async function rewardTarget(tenantId: string): Promise<RewardTarget | null> {
  if (getMode() === 'selfhost') {
    const client = await rewardStripe(tenantId);
    return client ? { client, connectionId: null } : null;
  }
  const target = await brandRewardsTarget(tenantId);
  return target ? { client: target.stripe, connectionId: target.connectionId } : null;
}

async function backfillCode(
  target: RewardTarget,
  tenantId: string,
  row: RewardCodeRow,
): Promise<'present' | 'linked' | 'provisioned' | 'taken' | 'failed' | 'skipped' | 'cleared'> {
  const { client } = target;
  let current = row.stripePromotionCodeId;
  if (current) {
    // Retrievable, active or not: a promo the brand deactivated in its
    // Dashboard stays deactivated.
    if (await isPromotionCodeId(client, current)) return 'present';
    // Another account's promo: no discount at this checkout. Say so before
    // trying, so a failure below leaves an honest null to retry.
    if (!(await recordReward(tenantId, row.id, target.connectionId, current, null))) return 'skipped';
    current = null;
  }
  // A suspended partner's code, or one whose program has no customer reward
  // now, keeps no promo: reinstated or switched back on, a sweep gives it one.
  if (!row.customerReward || row.partnerRevokedAt) return 'cleared';

  const found = await findCodeInStripe(client, row.code);
  if (found.kind === 'taken') {
    if (row.brandChosen) {
      // The admin typed this code to map the brand's own promo onto the
      // partner: that promo carries the discount, and the webhook credits it.
      console.info(`[customer-rewards] partner code ${row.code} (coupon ${row.id}, tenant ${tenantId}) maps the brand's own ${found.what}, as its admin chose; no promotion code created`);
      return 'taken';
    }
    // Codes minted before the connection were never checked against the
    // brand's Stripe (codeExistsInStripe had nothing to ask).
    console.error(
      `[customer-rewards] ALERT: partner code ${row.code} (coupon ${row.id}, tenant ${tenantId}) is also a ${found.what} in the brand's own Stripe. It was left without a promotion code. Stripe purchases using the brand's ${found.what} credit this partner only if the brand made it for the code, after the code existed (stripe-webhook.ts discountMadeForCoupon); if it is the brand's own promo, the brand should give the partner a new code`,
    );
    return 'taken';
  }
  if (found.kind === 'ours') {
    const coupon = found.promo.promotion?.coupon;
    const recorded = await recordReward(tenantId, row.id, target.connectionId, current, {
      stripeCouponId: (typeof coupon === 'string' ? coupon : coupon?.id) ?? null,
      stripePromotionCodeId: found.promo.id,
    });
    return recorded ? 'linked' : 'skipped';
  }

  const params = toStripeCouponParams(row.customerReward, rewardCouponName(row.programName, row.code));
  if (!params) {
    console.error('[customer-rewards] backfill: malformed customer reward', { tenantId, code: row.code });
    return 'failed';
  }
  const created = await createReward(client, params, row.code);
  if (await recordReward(tenantId, row.id, target.connectionId, current, created)) return 'provisioned';
  // Not recorded. If the code was retired meanwhile, nothing will ever own
  // this promo (no pass adopts one for a retired code), so release it, as
  // the mint path does — unless the retirement already did. Otherwise
  // leave it: another pass has it or will adopt it by its code (same
  // account), or it stays in the account that was replaced, like any promo
  // minted there.
  const now = await couponState(tenantId, row.id);
  if (now?.deactivatedAt && now.stripePromotionCodeId !== created.stripePromotionCodeId) {
    try {
      await client.promotionCodes.update(created.stripePromotionCodeId, { active: false });
    } catch (err) {
      console.error('[customer-rewards] backfill: releasing an unowned promo failed', { tenantId, code: row.code, err });
    }
  }
  return 'skipped';
}

/**
 * Store a code's Stripe ids, only if it's still active, still holds
 * `expected`, and (hosted) the connection they came through is still live.
 * That connection row is held FOR SHARE until this commits, so a reconnect
 * closing it waits for the write or makes it roll back. Either way a
 * connect's pass, which starts after that commit, sees whatever landed.
 *
 * Coupon row first, connection second. A coupon retirement holds the
 * Coupon row while its request finishes, and a token refresh holds the
 * connection row; the other order could wait on both at once.
 */
async function recordReward(
  tenantId: string,
  couponId: string,
  connectionId: string | null,
  expected: string | null,
  reward: { stripeCouponId: string | null; stripePromotionCodeId: string } | null,
): Promise<boolean> {
  try {
    return await withTenantTransaction(tenantId, async (trx) => {
      const q = trx(TABLES.Coupon).where({ id: couponId, tenantId }).whereNull('deactivatedAt');
      if (expected) q.where({ stripePromotionCodeId: expected });
      else q.whereNull('stripePromotionCodeId');
      const updated = await q.update({
        stripeCouponId: reward?.stripeCouponId ?? null,
        stripePromotionCodeId: reward?.stripePromotionCodeId ?? null,
      });
      if (updated === 0) return false;
      if (connectionId) {
        const live = await trx(TABLES.TenantStripeConnection)
          .where({ id: connectionId, tenantId })
          .whereNull('disconnectedAt')
          .forShare()
          .first('id');
        if (!live) throw new ConnectionClosed();
      }
      return true;
    });
  } catch (err) {
    if (err instanceof ConnectionClosed) return false;
    throw err;
  }
}

/** Rolls recordReward's write back: the connection was replaced or closed. */
class ConnectionClosed extends Error {}

async function couponState(
  tenantId: string,
  couponId: string,
): Promise<{ stripePromotionCodeId: string | null; deactivatedAt: Date | null } | undefined> {
  return (await withTenantTransaction(tenantId, async (trx) =>
    trx(TABLES.Coupon).where({ id: couponId, tenantId }).first('stripePromotionCodeId', 'deactivatedAt'),
  )) as { stripePromotionCodeId: string | null; deactivatedAt: Date | null } | undefined;
}

async function isPromotionCodeId(client: Stripe, id: string): Promise<boolean> {
  try {
    await client.promotionCodes.retrieve(id);
    return true;
  } catch (err) {
    if ((err as { code?: string }).code === 'resource_missing') return false;
    throw err;
  }
}

type CodeInStripe =
  | { kind: 'free' }
  | { kind: 'ours'; promo: Stripe.PromotionCode }
  | { kind: 'taken'; what: 'promotion code' | 'coupon id' };

/**
 * Where a code stands in the brand's account. Any promotion code with it
 * that OpenPartner didn't create (active or not, as in codeExistsInStripe),
 * or a coupon with it as its id, makes it the brand's. Otherwise an ACTIVE
 * promo of ours for it (metadata source=openpartner, openpartner_code the
 * same) is one an earlier pass created. An inactive one of ours doesn't
 * block a new one: Stripe keeps only active codes unique.
 */
async function findCodeInStripe(client: Stripe, code: string): Promise<CodeInStripe> {
  const promos: Stripe.PromotionCode[] = [];
  let startingAfter: string | undefined;
  do {
    const page = await client.promotionCodes.list({
      code,
      limit: 100,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    promos.push(...page.data);
    startingAfter = page.has_more ? page.data.at(-1)?.id : undefined;
  } while (startingAfter);

  const ours = (p: Stripe.PromotionCode) =>
    p.metadata?.source === 'openpartner' && p.metadata?.openpartner_code?.toLowerCase() === code.toLowerCase();
  if (promos.some((p) => !ours(p))) return { kind: 'taken', what: 'promotion code' };
  const active = promos.find((p) => p.active);
  if (active) return { kind: 'ours', promo: active };
  if (await isCouponId(client, code)) return { kind: 'taken', what: 'coupon id' };
  return { kind: 'free' };
}

const backfills = new Map<string, Promise<RewardBackfillResult | null>>();

/**
 * Run a backfill for the tenant in the background, after any pass already
 * queued for it in this process: a reconnect during a pass gets its own
 * pass, against the new connection. Never rejects; the outcome is logged.
 */
export function scheduleCustomerRewardBackfill(
  tenantId: string,
  opts: { verifyExisting: boolean },
): Promise<RewardBackfillResult | null> {
  const run: Promise<RewardBackfillResult | null> = (backfills.get(tenantId) ?? Promise.resolve(null))
    .then(() => backfillCustomerRewards(tenantId, opts))
    .then(
      (result) => {
        if (result.checked > 0 || result.stopped) console.info('[customer-rewards] backfill', { tenantId, ...result });
        return result;
      },
      (err: unknown) => {
        console.error('[customer-rewards] backfill failed', { tenantId, err });
        return null;
      },
    )
    .finally(() => {
      if (backfills.get(tenantId) === run) backfills.delete(tenantId);
    });
  backfills.set(tenantId, run);
  return run;
}

/** Is a pass queued or running for the tenant in this process? Integrations
 *  shows "creating" meanwhile instead of a count that's about to drop. */
export function customerRewardBackfillRunning(tenantId: string): boolean {
  return backfills.has(tenantId);
}

/** For tests: wait until no pass is queued or running. */
export async function __settleCustomerRewardBackfillsForTests(): Promise<void> {
  while (backfills.size > 0) await Promise.all(backfills.values());
}

/**
 * The scheduler's retry (hourly, hosted), for each connection that grants
 * the reward writes:
 *   - not verified yet (a connect's pass stopped early, ran in a process
 *     that died, or the connection predates verification): the full check;
 *   - verified, with codes still without a promotion code (a pass that
 *     couldn't provision them, a mint whose Stripe call failed, a program
 *     that gained a customer reward after its codes were minted): those.
 * Codes the brand owns are looked up again each time.
 */
export async function runRewardBackfillSweep(): Promise<
  Array<{ tenantId: string; pending: number; verified: boolean; result: RewardBackfillResult | null }>
> {
  const out: Array<{ tenantId: string; pending: number; verified: boolean; result: RewardBackfillResult | null }> = [];
  for (const { tenantId, verified } of await rewardConnections()) {
    const pending = await withTenantTransaction(tenantId, (trx) => rewardCodesNotInStripe(trx, tenantId));
    if (verified && pending === 0) continue;
    const result = await scheduleCustomerRewardBackfill(tenantId, { verifyExisting: !verified });
    out.push({ tenantId, pending, verified, result });
  }
  return out;
}
