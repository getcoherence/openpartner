/**
 * What a commission was earned on, in words, for commission lists.
 *
 * GET /partners/:id/commissions and GET /commissions say `source:
 * 'attribution'` (an attributed sale) or `'bonus'` (a reward with no sale
 * behind it), and carry the bonus for the latter, or the attributed
 * event's type for the former. Rows relayed by the Network may predate
 * these fields, so they are optional: no `source` means a sale.
 */

export interface CommissionSourceFields {
  source?: 'attribution' | 'bonus';
  /** The attributed event's type: `trial_started`, `invoice_paid`, a custom type. */
  eventType?: string | null;
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

/** An event type in words: `trial_started` → "Trial started", `invoice_paid` → "Invoice paid". */
export function eventTypeLabel(type: string): string {
  const words = type.replace(/[_.-]+/g, ' ').trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : type;
}

/** The event it was earned on ("Trial started", "Invoice paid"; "Sale" when
 *  unknown), or "Bonus", "Bonus: <note>", "Bounty: <name>", "Network bounty: <note>". */
export function commissionSourceLabel(c: CommissionSourceFields): string {
  if (!isBonusCommission(c)) return c.eventType ? eventTypeLabel(c.eventType) : 'Sale';
  const b = c.bonus!;
  if (b.source === 'performance_bounty') return b.bountyName ? `Bounty: ${b.bountyName}` : 'Bounty';
  const kind = b.source === 'network' ? 'Network bounty' : 'Bonus';
  return b.note ? `${kind}: ${b.note}` : kind;
}
