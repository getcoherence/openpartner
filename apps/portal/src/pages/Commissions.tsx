import { useInfiniteQuery } from '@tanstack/react-query';
import { Receipt } from 'lucide-react';
import { api, type Principal } from '../api.js';
import {
  commissionSourceLabel,
  isBonusCommission,
  isRecruiterCommission,
  type CommissionSourceFields,
} from '../lib/commission-source.js';
import { TenantLink } from '../tenant-link.js';
import { theme } from '../theme.js';
import { Avatar, Button, Card, EmptyState, ErrorBanner, Page, StatusPill, Table, formatDate, money, shortId } from '../ui.js';

export { StatusPill };

interface Commission extends CommissionSourceFields {
  id: string;
  partnerId: string;
  /** Null only if the partner record is gone. */
  partnerName?: string | null;
  amount: string;
  currency: string;
  status: string;
  accruedAt: string;
  paidAt: string | null;
  campaignName?: string | null;
  /** The attributed event; null on a bonus's commission. */
  eventId?: string | null;
}

const PAGE_SIZE = 200;

/** The partner's avatar and name; the start of their id if the record is
 *  gone. Shared with the review queue (AdminReview.tsx). */
export function CommissionPartnerCell({ c }: { c: Pick<Commission, 'partnerId' | 'partnerName'> }) {
  if (!c.partnerName) return <code style={{ color: theme.textDim, fontSize: 12 }}>{shortId(c.partnerId)}</code>;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
      <Avatar name={c.partnerName} size={26} />
      <span style={{ fontWeight: 500 }}>{c.partnerName}</span>
    </span>
  );
}

/** What it was earned on, with the program underneath. A bonus's note is
 *  the brand's own words to the partner, so it wraps rather than truncates.
 *  A bonus and a recruiter's share stand out from the sales around them.
 *  Shared with the review queue (AdminReview.tsx). */
export function CommissionSourceCell({ c }: { c: CommissionSourceFields & { campaignName?: string | null } }) {
  const standOut = isBonusCommission(c) || isRecruiterCommission(c);
  return (
    <span style={{ display: 'inline-flex', flexDirection: 'column', gap: 2, maxWidth: 320, whiteSpace: 'normal' }}>
      <span style={{ color: standOut ? theme.accentText : theme.text, fontWeight: standOut ? 500 : 400, overflowWrap: 'anywhere' }}>
        {commissionSourceLabel(c)}
      </span>
      {c.campaignName && <span style={{ fontSize: 12, color: theme.textDim }}>{c.campaignName}</span>}
    </span>
  );
}

export function CommissionsPage({ principal }: { principal: Principal }) {
  const queryPartnerId = new URLSearchParams(window.location.search).get('partnerId');
  const partnerId = principal.partnerId ?? queryPartnerId;

  const base = partnerId ? `/partners/${partnerId}/commissions` : `/commissions`;
  const { data, error, isLoading, fetchNextPage, hasNextPage, isFetchingNextPage } = useInfiniteQuery({
    queryKey: ['commissions', partnerId ?? 'all'],
    queryFn: ({ pageParam }) => {
      const qs = new URLSearchParams({ limit: String(PAGE_SIZE) });
      if (pageParam) qs.set('cursor', pageParam);
      return api<{ commissions: Commission[]; nextCursor: string | null }>(`${base}?${qs}`);
    },
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });

  const isAdminView = principal.role === 'admin' && !partnerId;
  const columns = isAdminView
    ? ['ID', 'Partner', 'Source', { label: 'Amount', align: 'right' as const }, 'Status', 'Accrued', 'Paid', 'Journey']
    : ['ID', 'Source', { label: 'Amount', align: 'right' as const }, 'Status', 'Accrued', 'Paid'];

  const rows = (data?.pages.flatMap((p) => p.commissions) ?? []).map((c) => {
    const base = [
      <code style={{ color: theme.textDim, fontSize: 12 }}>{shortId(c.id)}</code>,
      isAdminView ? <CommissionPartnerCell c={c} /> : null,
      <CommissionSourceCell c={c} />,
      <span style={{ fontWeight: 500 }}>{money(c.amount, c.currency)}</span>,
      <StatusPill status={c.status} />,
      <span style={{ color: theme.textMuted }}>{formatDate(c.accruedAt, { relative: true })}</span>,
      <span style={{ color: theme.textMuted }}>{formatDate(c.paidAt, { relative: true })}</span>,
      // Who else touched the customer, and why this partner got the credit.
      isAdminView ? (c.eventId ? <TenantLink to={`/admin/journey?event=${encodeURIComponent(c.eventId)}`}>Open</TenantLink> : <span />) : null,
    ];
    return base.filter((x) => x !== null) as React.ReactNode[];
  });

  return (
    <Page title="Commissions" subtitle={partnerId ? 'Earnings on attributed sales, and bonuses.' : 'Every partner, every commission.'}>
      <ErrorBanner error={error} />
      {isLoading ? (
        <Card>Loading…</Card>
      ) : rows.length === 0 ? (
        <EmptyState
          title="No commissions yet"
          hint="Commissions accrue when an attributed event is ingested, or when a bonus is paid."
          icon={<Receipt size={28} strokeWidth={1.25} />}
        />
      ) : (
        <>
          <Table columns={columns} rows={rows} />
          {hasNextPage && (
            <div style={{ display: 'flex', justifyContent: 'center', marginTop: 16 }}>
              <Button variant="secondary" size="sm" onClick={() => void fetchNextPage()} disabled={isFetchingNextPage}>
                {isFetchingNextPage ? 'Loading…' : `Load ${PAGE_SIZE} more`}
              </Button>
            </div>
          )}
        </>
      )}
    </Page>
  );
}
