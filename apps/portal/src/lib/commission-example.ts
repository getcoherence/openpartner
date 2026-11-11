/**
 * What one sale costs the brand under a simple commission rule, for the
 * setup wizard's worked example. All amounts in minor units (cents).
 *
 * The recruiter's share is a percentage of the partner's commission and is
 * paid on top of it, never out of it, so the brand's total is the sum.
 * Same rounding as the API's recruiterShareMinor (recruiter-commissions.ts).
 */
export interface CommissionExample {
  sale: number;
  partner: number;
  recruiter: number;
  total: number;
}

export function commissionExample(input: {
  type: 'percent' | 'fixed';
  /** Percent of the sale, or a fixed amount in major units. */
  value: number;
  /** Null: two-tier is off. */
  recruiterPercent: number | null;
  saleMinor?: number;
}): CommissionExample {
  const sale = input.saleMinor ?? 10_000;
  const value = Number.isFinite(input.value) && input.value > 0 ? input.value : 0;
  const partner = input.type === 'percent' ? Math.round((sale * value) / 100) : Math.round(value * 100);
  const pct = input.recruiterPercent;
  const recruiter = pct != null && Number.isFinite(pct) && pct > 0 ? Math.round((partner * pct) / 100) : 0;
  return { sale, partner, recruiter, total: partner + recruiter };
}
