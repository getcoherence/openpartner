import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Banknote, Play } from 'lucide-react';
import { api, type Principal } from '../api.js';
import { alpha, theme } from '../theme.js';
import { Button, Card, EmptyState, ErrorBanner, Page, StatusPill, Table, formatDate, money, shortId } from '../ui.js';

interface Payout {
  id: string;
  partnerId: string;
  amount: string;
  currency: string;
  method: string;
  status: string;
  createdAt: string;
  completedAt: string | null;
  stripeTransferId: string | null;
}

type HoldReason = 'country_not_supported' | 'screening_confirmed' | 'screening_review' | 'screening_pending';

/** GET /payouts/holds: partners on a compliance hold (OpenPartner Cloud). */
interface PayoutHold {
  partnerId: string;
  partnerName: string;
  partnerEmail: string;
  reason: HoldReason;
  effect: 'held' | 'warning';
  owed: Array<{ currency: string; amount: number }>;
}

const HOLD_REASON: Record<HoldReason, string> = {
  country_not_supported: 'Based in a country OpenPartner can’t send payouts to.',
  screening_review: 'Sanctions screening found a possible match. OpenPartner is reviewing it.',
  screening_confirmed: 'Sanctions screening confirmed a match.',
  screening_pending: 'Not screened against the sanctions lists yet. This usually clears within the hour.',
};

export function PayoutsPage({ principal }: { principal: Principal }) {
  const qc = useQueryClient();
  const queryPartnerId = new URLSearchParams(window.location.search).get('partnerId');
  const partnerId = principal.partnerId ?? queryPartnerId;

  const runPayouts = useMutation({
    mutationFn: () =>
      api<{
        runId: string;
        payouts: unknown[];
        skippedBelowThreshold: Array<{ partnerId: string; currency: string; amount: number }>;
        heldForCompliance?: Array<{ partnerId: string; currency: string; amount: number; reason: HoldReason }>;
      }>('/payouts/run', { method: 'POST' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['payouts'] });
      qc.invalidateQueries({ queryKey: ['payout-holds'] });
      qc.invalidateQueries({ queryKey: ['commissions'] });
      qc.invalidateQueries({ queryKey: ['admin-overview'] });
    },
  });

  const payouts = useQuery({
    queryKey: ['payouts', partnerId ?? 'none'],
    queryFn: () => api<{ payouts: Payout[] }>(`/partners/${partnerId}/payouts`),
    enabled: !!partnerId,
  });

  const holds = useQuery({
    queryKey: ['payout-holds'],
    queryFn: () => api<{ holds: PayoutHold[] }>('/payouts/holds'),
    enabled: principal.role === 'admin',
  });
  const shownHolds = (holds.data?.holds ?? []).filter((h) => !partnerId || h.partnerId === partnerId);

  const subtitle =
    principal.role === 'admin'
      ? partnerId
        ? 'History for this partner.'
        : 'Kick off a batch to pay out every approved commission.'
      : 'Your payout history.';

  const actions =
    principal.role === 'admin' ? (
      <Button icon={<Play size={14} />} onClick={() => runPayouts.mutate()} disabled={runPayouts.isPending}>
        {runPayouts.isPending ? 'Running…' : 'Run payouts'}
      </Button>
    ) : undefined;

  return (
    <Page title="Payouts" subtitle={subtitle} actions={actions}>
      <ErrorBanner error={runPayouts.error ?? payouts.error} />

      {shownHolds.length > 0 && (
        <Card style={{ marginBottom: 14, borderColor: alpha(theme.warn, 0.4) }}>
          <div style={{ fontSize: 13, color: theme.warn, fontWeight: 600, marginBottom: 4 }}>
            {shownHolds.length === 1 ? '1 partner is' : `${shownHolds.length} partners are`} on a compliance hold
          </div>
          <div style={{ fontSize: 12.5, color: theme.textMuted, marginBottom: 10, lineHeight: 1.5 }}>
            OpenPartner can’t send them money until the hold lifts. Their commissions stay approved and are paid on the
            first run after that. You don’t need to do anything.
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {shownHolds.map((h) => (
              <div key={h.partnerId} style={{ fontSize: 13, lineHeight: 1.45 }}>
                <span style={{ fontWeight: 600 }}>{h.partnerName}</span>
                <span style={{ color: theme.textDim }}> · {h.partnerEmail}</span>
                <span style={{ color: theme.textMuted }}> · owed {h.owed.map((o) => money(o.amount, o.currency)).join(' + ')}</span>
                <div style={{ fontSize: 12.5, color: theme.textMuted }}>{HOLD_REASON[h.reason]}</div>
                {h.effect === 'warning' && (
                  <div style={{ fontSize: 12.5, color: theme.warn }}>
                    You pay this partner yourself, so their payouts aren’t held. Check before you send them money.
                  </div>
                )}
              </div>
            ))}
          </div>
        </Card>
      )}

      {runPayouts.data && (
        <Card style={{ marginBottom: 14, borderColor: `${theme.accentA55}` }}>
          <div style={{ fontSize: 13, color: theme.accentText, fontWeight: 500, marginBottom: 8 }}>
            Run #{shortId(runPayouts.data.runId)} — {runPayouts.data.payouts.length} payout
            {runPayouts.data.payouts.length === 1 ? '' : 's'}
            {runPayouts.data.skippedBelowThreshold?.length > 0 && (
              <span style={{ color: theme.textMuted, fontWeight: 400 }}>
                {' '}
                · {runPayouts.data.skippedBelowThreshold.length} skipped below threshold
              </span>
            )}
            {(runPayouts.data.heldForCompliance?.length ?? 0) > 0 && (
              <span style={{ color: theme.warn, fontWeight: 400 }}>
                {' '}
                · {runPayouts.data.heldForCompliance!.length} on compliance hold
              </span>
            )}
          </div>
          <pre
            style={{
              margin: 0,
              background: theme.bg,
              color: theme.text,
              padding: 14,
              borderRadius: theme.radiusSm,
              fontSize: 12,
              overflow: 'auto',
              maxHeight: 280,
            }}
          >
            {JSON.stringify(
              {
                payouts: runPayouts.data.payouts,
                ...(runPayouts.data.skippedBelowThreshold?.length
                  ? { skippedBelowThreshold: runPayouts.data.skippedBelowThreshold }
                  : {}),
                ...(runPayouts.data.heldForCompliance?.length
                  ? { heldForCompliance: runPayouts.data.heldForCompliance }
                  : {}),
              },
              null,
              2,
            )}
          </pre>
        </Card>
      )}

      {!partnerId ? (
        <EmptyState
          title="Pick a partner"
          hint="Open a partner from Admin → Partners to see their payout history."
          icon={<Banknote size={28} strokeWidth={1.25} />}
        />
      ) : payouts.isLoading ? (
        <Card>Loading…</Card>
      ) : (payouts.data?.payouts ?? []).length === 0 ? (
        <EmptyState
          title="No payouts yet"
          hint="Approved commissions become payouts on the next run."
          icon={<Banknote size={28} strokeWidth={1.25} />}
        />
      ) : (
        <Table
          columns={['ID', { label: 'Amount', align: 'right' }, 'Method', 'Status', 'Created', 'Completed']}
          rows={(payouts.data?.payouts ?? []).map((p) => [
            <code style={{ color: theme.textDim, fontSize: 12 }}>{shortId(p.id)}</code>,
            <span style={{ fontWeight: 500 }}>{money(p.amount, p.currency)}</span>,
            <span style={{ color: theme.textMuted }}>{p.method.replace('_', ' ')}</span>,
            <StatusPill status={p.status} />,
            <span style={{ color: theme.textMuted }}>{formatDate(p.createdAt, { relative: true })}</span>,
            <span style={{ color: theme.textMuted }}>{formatDate(p.completedAt, { relative: true })}</span>,
          ])}
        />
      )}
    </Page>
  );
}
