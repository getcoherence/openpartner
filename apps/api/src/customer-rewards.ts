/**
 * Customer-side reward provisioning (dual-sided incentives, Path A).
 *
 * When a Campaign has a customerReward configured, every Coupon minted
 * for that Campaign gets a matching Stripe Coupon + PromotionCode so the
 * customer's discount applies automatically when they enter the code at
 * the brand's checkout.
 *
 * Failures are non-fatal: if Stripe isn't configured, or the API call
 * fails, the Coupon row is still written and stripeCouponId stays null.
 * The partner attribution path (POST /coupons/redeem) is independent of
 * Stripe and continues to work — the customer just doesn't get the
 * discount auto-applied. Admin can re-mint to retry.
 */

import type Stripe from 'stripe';
import type { CustomerReward } from '@openpartner/db';
import { stripe } from './stripe.js';

export interface ProvisionedReward {
  stripeCouponId: string;
  stripePromotionCodeId: string;
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
  reward: CustomerReward,
  code: string,
  campaignName: string,
): Promise<ProvisionedReward | null> {
  if (!stripe) return null;

  const couponParams = toStripeCouponParams(reward, `OpenPartner — ${campaignName} (${code})`);
  if (!couponParams) return null;

  try {
    const coupon = await stripe.coupons.create(couponParams);
    const promo = await stripe.promotionCodes.create({
      promotion: { type: 'coupon', coupon: coupon.id },
      code,
      metadata: { source: 'openpartner', openpartner_code: code },
    });
    return { stripeCouponId: coupon.id, stripePromotionCodeId: promo.id };
  } catch (err) {
    console.error('[customer-rewards] Stripe provisioning failed', { code, err });
    return null;
  }
}

/**
 * Disable a Stripe PromotionCode so customers entering the string at
 * checkout get "promotion code is no longer valid" instead of a discount.
 * Used by the coupon-deactivate flow (partner retiring an old code).
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
export async function deactivateCustomerReward(stripePromotionCodeId: string): Promise<void> {
  if (!stripe) return;
  try {
    await stripe.promotionCodes.update(stripePromotionCodeId, { active: false });
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
    amount_off: Math.round(reward.value * 100),
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
