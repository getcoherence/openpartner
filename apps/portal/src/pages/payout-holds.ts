/** Why a partner is on a compliance hold (GET /payouts/holds, and the
 *  `complianceWarning` on a manual payout). OpenPartner Cloud only. */
export type HoldReason = 'country_not_supported' | 'screening_confirmed' | 'screening_review' | 'screening_pending';

export const HOLD_REASON: Record<HoldReason, string> = {
  country_not_supported: 'Based in a country OpenPartner can’t send payouts to.',
  screening_review: 'Sanctions screening found a possible match. OpenPartner is reviewing it.',
  screening_confirmed: 'Sanctions screening confirmed a match.',
  screening_pending: 'Not screened against the sanctions lists yet. This usually clears within the hour.',
};
