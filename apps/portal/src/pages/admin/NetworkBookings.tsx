/**
 * Network → Bookings: every creator booking at a glance. Each one lives in
 * your conversation with that creator (Network → Messages), where you pay,
 * track and approve it. A booking goes request → the creator accepts at a
 * price (or sends an offer) → you pay upfront through Stripe on their own
 * account → they deliver → you approve.
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CalendarCheck } from 'lucide-react';
import { api } from '../../api.js';
import { Button, Card, EmptyState, ErrorBanner, Page, formatDate } from '../../ui.js';
import { theme } from '../../theme.js';
import { TenantLink } from '../../tenant-link.js';
import { BookingStatusPill, Face, formatMinor, formatWholeAmount, type BookingStatus } from '../creator/conversation-shared.js';
import type { VendorBooking } from './NetworkMessages.js';

const FILTERS: Array<{ key: BookingStatus | 'all'; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'pending', label: 'Waiting on creator' },
  { key: 'awaiting_payment', label: 'To pay' },
  { key: 'paid', label: 'In progress' },
  { key: 'delivered', label: 'To review' },
  { key: 'completed', label: 'Completed' },
];

function amountText(b: VendorBooking): string {
  if (b.totalMinor != null && b.currency && b.status !== 'pending') return formatMinor(b.totalMinor, b.currency);
  if (b.amount == null || !b.currency) return 'Price to agree';
  return formatWholeAmount(b.amount, b.currency);
}

export function AdminNetworkBookings() {
  const [filter, setFilter] = useState<BookingStatus | 'all'>('all');
  const list = useQuery({
    queryKey: ['admin-network-bookings', filter],
    queryFn: () => api<{ bookings: VendorBooking[] }>(`/admin/network/bookings${filter === 'all' ? '' : `?status=${filter}`}`),
    retry: false,
  });
  return (
    <Page
      title="Bookings"
      subtitle="Creators you booked. Pay, track and approve each one in your conversation with the creator."
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
          hint="Find a creator under Discover creators and request one of their packages. You pay once they’ve accepted."
          icon={<CalendarCheck size={28} strokeWidth={1.25} />}
        />
      ) : (
        <Card padded={false}>
          {list.data.bookings.map((b, i) => {
            const row = (
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', borderTop: i === 0 ? 'none' : `1px solid ${theme.borderSubtle}` }}>
                <Face name={b.creator?.name ?? '?'} src={b.creator?.avatarUrl} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 14, fontWeight: 500, color: theme.text }}>{b.package?.title ?? 'Custom collaboration'}</span>
                    <BookingStatusPill status={b.status} />
                  </div>
                  <div style={{ fontSize: 13, color: theme.textMuted, marginTop: 2 }}>
                    {b.creator?.name ?? 'Creator removed'}
                    {b.offering && <> · tracked on {b.offering.title}</>}
                  </div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontSize: 14, fontWeight: 600, color: theme.text }}>{amountText(b)}</div>
                  <div style={{ fontSize: 12, color: theme.textDim, marginTop: 2 }}>{formatDate(b.paidAt ?? b.createdAt)}</div>
                </div>
              </div>
            );
            return b.conversationId ? (
              <TenantLink key={b.id} to={`/admin/network/messages/${b.conversationId}`} style={{ textDecoration: 'none', display: 'block' }}>
                {row}
              </TenantLink>
            ) : (
              <div key={b.id}>{row}</div>
            );
          })}
        </Card>
      )}
    </Page>
  );
}
