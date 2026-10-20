/**
 * Network → Bookings: creators this brand booked from Discover creators.
 * A booking goes pending → accepted (the creator is now your partner on
 * the offering) → delivered (they posted the URLs) → you approve → the
 * Network pays the agreed amount as a bonus through your program.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarCheck } from 'lucide-react';
import { api } from '../../api.js';
import { Button, Card, EmptyState, ErrorBanner, Page, StatusPill, formatDate } from '../../ui.js';
import { theme } from '../../theme.js';
import { TenantLink } from '../../tenant-link.js';
import { formatPackagePrice } from '../creator/storefront-shared.js';
import { networkErrorCode } from './BookCreatorDialog.js';
import { DeliveryChecksPanel, type DeliveryChecks } from './DeliveryChecks.js';

type BookingStatus = 'pending' | 'accepted' | 'declined' | 'cancelled' | 'delivered' | 'approved' | 'paid' | 'payout_failed';

interface VendorBooking {
  id: string;
  status: BookingStatus;
  creator: { id: string; name: string; handle: string | null; avatarUrl: string | null } | null;
  package: { title: string; priceAmount: number | null; priceIsFrom: boolean; currency: string } | null;
  offering: { id: string; title: string } | null;
  brief: string;
  amount: number | null;
  currency: string | null;
  creatorMessage: string | null;
  deliverableUrls: string[];
  partnerId: string | null;
  shareUrl: string | null;
  payoutError: string | null;
  createdAt: string;
  deliveredAt: string | null;
  paidAt: string | null;
  /** Null until the Network's first check of the delivered posts finishes;
   *  absent on a Network without delivery checks. */
  deliveryChecks?: DeliveryChecks | null;
}

const FILTERS: Array<{ key: BookingStatus | 'all'; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'pending', label: 'Waiting on creator' },
  { key: 'accepted', label: 'In progress' },
  { key: 'delivered', label: 'To review' },
  { key: 'paid', label: 'Paid' },
];

const STATUS_LABEL: Record<BookingStatus, string> = {
  pending: 'waiting on creator',
  accepted: 'in progress',
  declined: 'declined',
  cancelled: 'cancelled',
  delivered: 'to review',
  approved: 'paying',
  paid: 'paid',
  payout_failed: 'payment failed',
};

function amountText(b: VendorBooking): string {
  if (b.amount == null || !b.currency) return '—';
  return formatPackagePrice({ priceAmount: b.amount, priceIsFrom: false, currency: b.currency });
}

export function AdminNetworkBookings() {
  const [filter, setFilter] = useState<BookingStatus | 'all'>('all');
  const list = useQuery({
    queryKey: ['admin-network-bookings', filter],
    queryFn: () =>
      api<{ bookings: VendorBooking[] }>(`/admin/network/bookings${filter === 'all' ? '' : `?status=${filter}`}`),
    retry: false,
    // Delivery checks run in the background right after delivery; poll
    // briefly until they land so the badges appear without a reload.
    refetchInterval: (query) =>
      query.state.data?.bookings.some((b) => b.deliverableUrls.length > 0 && b.deliveryChecks === null) ? 5_000 : false,
  });
  return (
    <Page
      title="Bookings"
      subtitle="Creators you booked from their storefronts. Approve delivered work to pay them through your program."
      actions={
        <TenantLink to="/admin/network/creators" style={{ textDecoration: 'none' }}>
          <Button variant="secondary">Discover creators</Button>
        </TenantLink>
      }
    >
      <div style={{ display: 'flex', gap: 6, marginBottom: 14, flexWrap: 'wrap' }}>
        {FILTERS.map((f) => (
          <Button key={f.key} size="sm" variant={filter === f.key ? 'primary' : 'secondary'} onClick={() => setFilter(f.key)}>
            {f.label}
          </Button>
        ))}
      </div>
      <ErrorBanner error={list.error} />
      {list.isLoading ? (
        <Card>Loading…</Card>
      ) : !list.data || list.data.bookings.length === 0 ? (
        <EmptyState
          title="No bookings yet"
          hint="Find a creator under Discover creators and book one of their packages. You pay once you’ve approved the published post."
          icon={<CalendarCheck size={28} strokeWidth={1.25} />}
        />
      ) : (
        <div style={{ display: 'grid', gap: 10 }}>
          {list.data.bookings.map((b) => (
            <BookingCard key={b.id} booking={b} />
          ))}
        </div>
      )}
    </Page>
  );
}

function BookingCard({ booking: b }: { booking: VendorBooking }) {
  const qc = useQueryClient();
  const act = useMutation({
    mutationFn: (action: 'approve' | 'cancel' | 'retry-payout' | 'recheck') =>
      api(`/admin/network/bookings/${b.id}/${action}`, { method: 'POST', body: {} }),
    onSettled: () => qc.invalidateQueries({ queryKey: ['admin-network-bookings'] }),
  });
  const code = networkErrorCode(act.error);

  return (
    <Card>
      <ErrorBanner error={code === 'not_delivered' ? 'The creator hasn’t delivered yet.' : act.error} />
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
        {b.creator?.avatarUrl ? (
          <img src={b.creator.avatarUrl} alt="" style={{ width: 36, height: 36, borderRadius: '50%', objectFit: 'cover', background: theme.surface2 }} />
        ) : (
          <div style={{ width: 36, height: 36, borderRadius: '50%', background: theme.accent, color: theme.accentInk, display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 600 }}>
            {(b.creator?.name ?? '?').charAt(0).toUpperCase()}
          </div>
        )}
        <div style={{ flex: 1, minWidth: 200 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 15, fontWeight: 500 }}>{b.package?.title ?? 'Custom collaboration'}</span>
            <StatusPill status={STATUS_LABEL[b.status]} />
          </div>
          <div style={{ fontSize: 13, color: theme.textMuted, marginTop: 3 }}>
            {b.creator ? (
              b.creator.handle ? (
                <a href={`/creators/${b.creator.handle}`} target="_blank" rel="noopener noreferrer" style={{ color: theme.accentText }}>
                  {b.creator.name}
                </a>
              ) : (
                b.creator.name
              )
            ) : (
              'Creator removed'
            )}
            {b.offering && <> · for {b.offering.title}</>}
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: 15, fontWeight: 600 }}>{amountText(b)}</div>
          <div style={{ fontSize: 12, color: theme.textDim, marginTop: 2 }}>{formatDate(b.paidAt ?? b.deliveredAt ?? b.createdAt)}</div>
        </div>
      </div>

      <div style={{ fontSize: 13, color: theme.textMuted, marginTop: 10, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{b.brief}</div>
      {b.creatorMessage && (
        <div style={{ fontSize: 13, marginTop: 8, whiteSpace: 'pre-wrap' }}>
          <span style={{ color: theme.textMuted }}>Creator:</span> {b.creatorMessage}
        </div>
      )}

      {b.deliverableUrls.length > 0 && (
        <DeliveryChecksPanel
          urls={b.deliverableUrls}
          checks={b.deliveryChecks}
          onRecheck={() => act.mutate('recheck')}
          rechecking={act.isPending && act.variables === 'recheck'}
        />
      )}

      {b.status === 'payout_failed' && b.payoutError && (
        <div style={{ marginTop: 12, fontSize: 13, color: theme.danger, background: theme.dangerSoft, borderRadius: theme.radiusSm, padding: '10px 12px', wordBreak: 'break-word' }}>
          Payment didn&rsquo;t go through: {b.payoutError}
        </div>
      )}
      {b.status === 'approved' && (
        <div style={{ marginTop: 12, fontSize: 13, color: theme.textMuted }}>Approved. The payment is being recorded and retries automatically.</div>
      )}

      <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap', alignItems: 'center' }}>
        {b.status === 'delivered' && (
          <Button
            disabled={act.isPending}
            onClick={() => {
              if (window.confirm(`Approve this work and pay ${amountText(b)} to ${b.creator?.name ?? 'the creator'}?`)) act.mutate('approve');
            }}
          >
            {act.isPending ? 'Approving…' : `Approve & pay ${amountText(b)}`}
          </Button>
        )}
        {b.status === 'payout_failed' && (
          <Button disabled={act.isPending} onClick={() => act.mutate('retry-payout')}>
            {act.isPending ? 'Retrying…' : 'Retry payment'}
          </Button>
        )}
        {(b.status === 'pending' || b.status === 'accepted') && (
          <Button
            variant="secondary"
            disabled={act.isPending}
            onClick={() => {
              if (window.confirm('Cancel this booking? The creator is told.')) act.mutate('cancel');
            }}
          >
            Cancel booking
          </Button>
        )}
        <div style={{ flex: 1 }} />
        {b.partnerId && (
          <TenantLink to={`/admin/partners/${b.partnerId}/commission`} style={{ fontSize: 13, color: theme.accentText }}>
            Partner &amp; earnings
          </TenantLink>
        )}
      </div>
    </Card>
  );
}
