/**
 * Runtime copies of the @openpartner/db string unions the spec enumerates.
 * The db package only ships them as types; `Exhaustive` makes the compiler
 * fail here if a member is added to (or removed from) a union without
 * updating the list.
 */

import type { AttributionModel, BonusSource, CommissionStatus, PayoutMethod, PayoutStatus } from '@openpartner/db';

type Exhaustive<Union extends string, List extends readonly Union[]> = [Union] extends [List[number]] ? List : never;

function exhaustive<Union extends string>() {
  return <const List extends readonly Union[]>(list: Exhaustive<Union, List>): List => list;
}

export const ATTRIBUTION_MODELS = exhaustive<AttributionModel>()(['last_click', 'first_click', 'linear', 'position']);
export const COMMISSION_STATUSES = exhaustive<CommissionStatus>()(['accrued', 'approved', 'paid', 'reversed']);
export const PAYOUT_METHODS = exhaustive<PayoutMethod>()(['stripe_connect', 'manual', 'external']);
export const PAYOUT_STATUSES = exhaustive<PayoutStatus>()(['pending', 'paid', 'failed', 'partially_reversed', 'reversed']);
export const BONUS_SOURCES = exhaustive<BonusSource>()(['manual', 'performance_bounty', 'network']);
