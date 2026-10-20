import type { ReactNode } from 'react';
import { CheckCircle2, X } from 'lucide-react';
import { alpha, theme } from '../theme.js';
import { Avatar, Card, StatusPill, money, shortId } from '../ui.js';
import { HOLD_REASON, type HoldReason } from './payout-holds.js';

interface MoneyGroup {
  partnerId: string;
  partnerName: string | null;
  currency: string;
  amount: number;
}

/** POST /payouts/run: what happened to each partner with approved commissions. */
export interface PayoutRunResult {
  runId: string;
  payouts: Array<
    MoneyGroup & {
      payoutId: string;
      method: string;
      status: string;
      clawbackAmount?: number;
      complianceWarning?: HoldReason;
      error?: string;
    }
  >;
  skippedBelowThreshold: MoneyGroup[];
  skippedUnfunded?: MoneyGroup[];
  heldForClawback?: Array<MoneyGroup & { clawbackAmount: number }>;
  heldForCompliance?: Array<MoneyGroup & { reason: HoldReason }>;
}

const METHOD: Record<string, string> = {
  stripe_connect: 'Stripe',
  manual: 'Manual',
  external: 'External',
};

/** How a payout is sent, in words: "Stripe", "Manual". */
export function payoutMethodLabel(method: string): string {
  return METHOD[method] ?? method.replace(/_/g, ' ');
}

/** "$1,240.00", or "$1,240.00 + €80.00" across currencies (never added together). */
function totals(groups: Array<{ amount: number; currency: string }>): string {
  const by = new Map<string, number>();
  for (const g of groups) by.set(g.currency, (by.get(g.currency) ?? 0) + g.amount);
  return [...by].map(([currency, amount]) => money(amount, currency)).join(' + ');
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/**
 * A payout run's result, in words: who was paid and how, who carried over
 * below the threshold, and who is held. Shown after "Run payouts".
 */
export function PayoutRunSummary({ result, onDismiss }: { result: PayoutRunResult; onDismiss: () => void }) {
  const { payouts, skippedBelowThreshold } = result;
  const held = result.heldForCompliance ?? [];
  const clawback = result.heldForClawback ?? [];
  const unfunded = result.skippedUnfunded ?? [];
  const toSend = payouts.filter((p) => p.method === 'manual' && p.status === 'pending').length;
  const nothing =
    payouts.length + skippedBelowThreshold.length + held.length + clawback.length + unfunded.length === 0;
  const note = nothing
    ? 'No partner has approved commissions waiting.'
    : toSend > 0
      ? `You send ${toSend === 1 ? 'the manual payout' : `the ${toSend} manual payouts`} yourself, then mark ${toSend === 1 ? 'it' : 'them'} as sent below.`
      : payouts.some((p) => p.method === 'stripe_connect')
        ? 'Stripe payouts go straight to each partner’s own Stripe account.'
        : null;

  return (
    <section aria-label="Payout run">
      <Card style={{ marginBottom: 14, borderColor: theme.accentA55 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: nothing ? 0 : 14 }}>
          <CheckCircle2 size={18} style={{ color: theme.accentText, flexShrink: 0, marginTop: 1 }} />
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 15, fontWeight: 500 }}>
              {payouts.length > 0
                ? `Payout run finished: ${plural(payouts.length, 'payout')}, ${totals(payouts)}`
                : 'Payout run finished: no payouts this time'}
            </div>
            {note && <div style={{ fontSize: 12.5, color: theme.textMuted, marginTop: 3, lineHeight: 1.5 }}>{note}</div>}
          </div>
          <button
            onClick={onDismiss}
            aria-label="Dismiss"
            style={{ background: 'none', border: 'none', padding: 2, cursor: 'pointer', color: theme.textDim, display: 'inline-flex' }}
          >
            <X size={16} />
          </button>
        </div>

        {payouts.length > 0 && (
          <Section title="Payouts">
            {payouts.map((p) => (
              <Row key={p.payoutId}>
                <PartnerCell name={p.partnerName} id={p.partnerId}>
                  {p.clawbackAmount ? (
                    <Note>After {money(p.clawbackAmount, p.currency)} in refund clawbacks.</Note>
                  ) : null}
                  {p.complianceWarning && (
                    <Note warn>On a compliance hold: {HOLD_REASON[p.complianceWarning]} Check before you send it.</Note>
                  )}
                  {p.status === 'failed' && p.error && <Note danger>{p.error}</Note>}
                </PartnerCell>
                <Amount>{money(p.amount, p.currency)}</Amount>
                <span style={{ width: 70, fontSize: 13, color: theme.textMuted }}>{payoutMethodLabel(p.method)}</span>
                <span style={{ width: 70, textAlign: 'right' }}>
                  <StatusPill status={p.status} />
                </span>
              </Row>
            ))}
          </Section>
        )}

        {skippedBelowThreshold.length > 0 && (
          <Section
            title="Carried over"
            hint="Below your payout threshold. Their approved commissions roll into the next run."
          >
            {skippedBelowThreshold.map((g) => (
              <Row key={`${g.partnerId}:${g.currency}`}>
                <PartnerCell name={g.partnerName} id={g.partnerId} />
                <Amount>{money(g.amount, g.currency)}</Amount>
              </Row>
            ))}
          </Section>
        )}

        {held.length > 0 && (
          <Section
            title="On a compliance hold"
            hint="OpenPartner can’t send them money until the hold lifts. Their commissions stay approved and are paid on the first run after that."
          >
            {held.map((g) => (
              <Row key={`${g.partnerId}:${g.currency}`}>
                <PartnerCell name={g.partnerName} id={g.partnerId}>
                  <Note warn>{HOLD_REASON[g.reason]}</Note>
                </PartnerCell>
                <Amount>{money(g.amount, g.currency)}</Amount>
              </Row>
            ))}
          </Section>
        )}

        {clawback.length > 0 && (
          <Section
            title="Waiting on refunds"
            hint="Refunds they still owe back are at least what they’ve earned. They’re paid, net, once enough accrues."
          >
            {clawback.map((g) => (
              <Row key={`${g.partnerId}:${g.currency}`}>
                <PartnerCell name={g.partnerName} id={g.partnerId}>
                  <Note>Owes {money(g.clawbackAmount, g.currency)} in refunds.</Note>
                </PartnerCell>
                <Amount>{money(g.amount, g.currency)}</Amount>
              </Row>
            ))}
          </Section>
        )}

        {unfunded.length > 0 && (
          <Section
            title="Not paid this run"
            hint="Paid through Stripe, which couldn’t be funded for them this run. Their commissions stay approved for a later run."
          >
            {unfunded.map((g) => (
              <Row key={`${g.partnerId}:${g.currency}`}>
                <PartnerCell name={g.partnerName} id={g.partnerId} />
                <Amount>{money(g.amount, g.currency)}</Amount>
              </Row>
            ))}
          </Section>
        )}
      </Card>
    </section>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <div style={{ marginTop: 14 }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: theme.textDim, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
        {title}
      </div>
      {hint && <div style={{ fontSize: 12.5, color: theme.textMuted, marginTop: 2, lineHeight: 1.5 }}>{hint}</div>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>{children}</div>
    </div>
  );
}

function Row({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        flexWrap: 'wrap',
        padding: '9px 12px',
        background: theme.bg,
        border: `1px solid ${theme.borderSubtle}`,
        borderRadius: theme.radiusSm,
      }}
    >
      {children}
    </div>
  );
}

/** The partner's avatar and name, with any notes under the name. A partner
 *  whose record is gone has no name: show the start of their id. */
function PartnerCell({ name, id, children }: { name: string | null; id: string; children?: ReactNode }) {
  return (
    <div style={{ flex: 1, minWidth: 200, display: 'flex', alignItems: 'center', gap: 10 }}>
      <Avatar name={name ?? '?'} size={26} />
      <div style={{ minWidth: 0 }}>
        {name ? (
          <div style={{ fontSize: 13.5, fontWeight: 500 }}>{name}</div>
        ) : (
          <code style={{ fontSize: 12, color: theme.textDim }}>{shortId(id)}</code>
        )}
        {children}
      </div>
    </div>
  );
}

function Amount({ children }: { children: ReactNode }) {
  return (
    <span style={{ width: 110, textAlign: 'right', fontSize: 13.5, fontWeight: 500, fontVariantNumeric: 'tabular-nums' }}>
      {children}
    </span>
  );
}

function Note({ children, warn, danger }: { children: ReactNode; warn?: boolean; danger?: boolean }) {
  const color = danger ? theme.danger : warn ? theme.warn : null;
  return (
    <div
      style={{
        fontSize: 12,
        marginTop: 3,
        lineHeight: 1.45,
        color: color ?? theme.textMuted,
        ...(color ? { background: alpha(color, 0.08), padding: '2px 6px', borderRadius: 4 } : {}),
      }}
    >
      {children}
    </div>
  );
}
