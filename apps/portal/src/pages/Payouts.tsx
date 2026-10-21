import { useInfiniteQuery, useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Banknote, Play } from 'lucide-react';
import { useSearchParams } from 'react-router';
import { api, type Principal } from '../api.js';
import { TenantLink } from '../tenant-link.js';
import { alpha, theme } from '../theme.js';
import { Avatar, Button, Card, EmptyState, ErrorBanner, Page, SectionHeading, StatusPill, Table, formatDate, money, shortId } from '../ui.js';
import { HOLD_REASON, type HoldReason } from './payout-holds.js';
import { ManualPayoutFiles } from './ManualPayoutFiles.js';
import { PayoutRunSummary, payoutMethodLabel, type PayoutRunResult } from './PayoutRunSummary.js';

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

/** GET /payouts: every partner's payouts, with the partner's name. */
interface PayoutListItem extends Payout {
  partnerName: string | null;
}

const PAGE_SIZE = 50;

/** GET /payouts/holds: partners on a compliance hold (OpenPartner Cloud). */
interface PayoutHold {
  partnerId: string;
  partnerName: string;
  partnerEmail: string;
  reason: HoldReason;
  effect: 'held' | 'warning';
  owed: Array<{ currency: string; amount: number }>;
}

export function PayoutsPage({ principal }: { principal: Principal }) {
  const qc = useQueryClient();
  const [searchParams] = useSearchParams();
  const partnerId = principal.partnerId ?? searchParams.get('partnerId');
  const isAdmin = principal.role === 'admin';

  const runPayouts = useMutation({
    mutationFn: () => api<PayoutRunResult>('/payouts/run', { method: 'POST' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['payouts'] });
      qc.invalidateQueries({ queryKey: ['payout-holds'] });
      qc.invalidateQueries({ queryKey: ['manual-payout-runs'] });
      qc.invalidateQueries({ queryKey: ['commissions'] });
      qc.invalidateQueries({ queryKey: ['admin-overview'] });
    },
  });

  const payouts = useQuery({
    queryKey: ['payouts', partnerId ?? 'none'],
    queryFn: () => api<{ payouts: Payout[] }>(`/partners/${partnerId}/payouts`),
    enabled: !!partnerId,
  });

  // An admin looking at one partner's history: whose it is.
  const partner = useQuery({
    queryKey: ['partner', partnerId],
    queryFn: () => api<{ id: string; name: string }>(`/partners/${partnerId}`),
    enabled: isAdmin && !!partnerId,
  });

  const holds = useQuery({
    queryKey: ['payout-holds'],
    queryFn: () => api<{ holds: PayoutHold[] }>('/payouts/holds'),
    enabled: isAdmin,
  });
  const shownHolds = (holds.data?.holds ?? []).filter((h) => !partnerId || h.partnerId === partnerId);

  const subtitle = isAdmin
    ? partnerId
      ? partner.data
        ? `Payout history for ${partner.data.name}.`
        : 'Payout history for this partner.'
      : 'Run a payout to pay every partner their approved commissions.'
    : 'Your payout history.';

  const actions = isAdmin ? (
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

      {runPayouts.data && <PayoutRunSummary result={runPayouts.data} onDismiss={() => runPayouts.reset()} />}

      {isAdmin && !partnerId && <ManualPayoutFiles />}

      {isAdmin && partnerId && (
        <TenantLink
          to="/payouts"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: theme.accentText, fontSize: 13, marginBottom: 12, textDecoration: 'none' }}
        >
          <ArrowLeft size={14} /> All payouts
        </TenantLink>
      )}

      {!partnerId ? (
        isAdmin ? <RecentPayouts /> : null
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
            <span style={{ color: theme.textMuted }}>{payoutMethodLabel(p.method)}</span>,
            <StatusPill status={p.status} />,
            <span style={{ color: theme.textMuted }}>{formatDate(p.createdAt, { relative: true })}</span>,
            <span style={{ color: theme.textMuted }}>{formatDate(p.completedAt, { relative: true })}</span>,
          ])}
        />
      )}
    </Page>
  );
}

/** Every partner's payouts, newest first: the admin page with no partner picked. */
function RecentPayouts() {
  const { data, error, isLoading, fetchNextPage, hasNextPage, isFetchingNextPage } = useInfiniteQuery({
    queryKey: ['payouts', 'all'],
    queryFn: ({ pageParam }) => {
      const qs = new URLSearchParams({ limit: String(PAGE_SIZE) });
      if (pageParam) qs.set('cursor', pageParam);
      return api<{ payouts: PayoutListItem[]; nextCursor: string | null }>(`/payouts?${qs}`);
    },
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });
  const rows = data?.pages.flatMap((p) => p.payouts) ?? [];

  return (
    <>
      <SectionHeading>Recent payouts</SectionHeading>
      <ErrorBanner error={error} />
      {isLoading ? (
        <Card>Loading…</Card>
      ) : rows.length === 0 ? (
        <EmptyState
          title="No payouts yet"
          hint="Approved commissions become payouts on the next run."
          icon={<Banknote size={28} strokeWidth={1.25} />}
        />
      ) : (
        <>
          <Table
            columns={['Partner', { label: 'Amount', align: 'right' }, 'Method', 'Status', 'Created', 'Completed']}
            rows={rows.map((p) => [
              <TenantLink
                to={`/payouts?partnerId=${p.partnerId}`}
                title="Payout history"
                style={{ display: 'inline-flex', alignItems: 'center', gap: 10, color: theme.text, textDecoration: 'none' }}
              >
                <Avatar name={p.partnerName ?? '?'} size={26} />
                {p.partnerName ? (
                  <span style={{ fontWeight: 500 }}>{p.partnerName}</span>
                ) : (
                  <code style={{ color: theme.textDim, fontSize: 12 }}>{shortId(p.partnerId)}</code>
                )}
              </TenantLink>,
              <span style={{ fontWeight: 500 }}>{money(p.amount, p.currency)}</span>,
              <span style={{ color: theme.textMuted }}>{payoutMethodLabel(p.method)}</span>,
              <StatusPill status={p.status} />,
              <span style={{ color: theme.textMuted }}>{formatDate(p.createdAt, { relative: true })}</span>,
              <span style={{ color: theme.textMuted }}>{formatDate(p.completedAt, { relative: true })}</span>,
            ])}
          />
          {hasNextPage && (
            <div style={{ display: 'flex', justifyContent: 'center', marginTop: 16 }}>
              <Button variant="secondary" size="sm" onClick={() => void fetchNextPage()} disabled={isFetchingNextPage}>
                {isFetchingNextPage ? 'Loading…' : `Load ${PAGE_SIZE} more`}
              </Button>
            </div>
          )}
        </>
      )}
    </>
  );
}
