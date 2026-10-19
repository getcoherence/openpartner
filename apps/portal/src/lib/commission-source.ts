/**
 * What a commission was earned on, in words, for commission lists.
 *
 * GET /partners/:id/commissions and GET /commissions say `source:
 * 'attribution'` (an attributed sale) or `'bonus'` (a reward with no sale
 * behind it), and carry the bonus for the latter. Rows relayed by the
 * Network may predate the field, so it is optional: no `source` means a sale.
 */

export interface CommissionSourceFields {
  source?: 'attribution' | 'bonus';
  bonus?: {
    source: string;
    note: string | null;
    bountyId: string | null;
    /** The performance bounty's name, when a bounty paid it. */
    bountyName?: string | null;
  } | null;
}

export function isBonusCommission(c: CommissionSourceFields): boolean {
  return c.source === 'bonus' && !!c.bonus;
}

/** "Sale", "Bonus", "Bonus: <note>", "Bounty: <name>" or "Network bounty: <note>". */
export function commissionSourceLabel(c: CommissionSourceFields): string {
  if (!isBonusCommission(c)) return 'Sale';
  const b = c.bonus!;
  if (b.source === 'performance_bounty') return b.bountyName ? `Bounty: ${b.bountyName}` : 'Bounty';
  const kind = b.source === 'network' ? 'Network bounty' : 'Bonus';
  return b.note ? `${kind}: ${b.note}` : kind;
}
