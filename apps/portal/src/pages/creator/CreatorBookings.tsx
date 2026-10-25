/**
 * /creator/bookings — every booking from the creator's storefront at a
 * glance. Each one lives in the conversation with that brand (Messages),
 * where the creator accepts at a price or declines, sends offers, delivers
 * once the brand has paid, and refunds. Brands pay upfront into the
 * creator's own Stripe account (the Network's docs/creator-storefront.md §8).
 *
 * Older requests from before conversations show here too. A brand's older
 * booking was given its conversation when phase 3 shipped (the Network's
 * backfill migration), so it opens like any other. One with no brand behind
 * it (a public request from before requesters became brands) can't be
 * booked: it can be declined, and deleted once answered.
 */
import { useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Inbox } from 'lucide-react';
import { Button, Card, EmptyState, ErrorBanner, Page, formatDate } from '../../ui.js';
import { theme } from '../../theme.js';
import { creatorApi } from './creator-api.js';
import { BookingStatusPill, formatMinor, formatWholeAmount, type BookingStatus } from './conversation-shared.js';
import type { CreatorBooking } from './CreatorMessages.js';

const FILTERS: Array<{ key: BookingStatus | 'all'; label: string }> = [
  { key: 'pending', label: 'To answer' },
  { key: 'awaiting_payment', label: 'Awaiting payment' },
  { key: 'paid', label: 'To deliver' },
  { key: 'delivered', label: 'Delivered' },
  { key: 'completed', label: 'Completed' },
  { key: 'all', label: 'All' },
];

/** Answered, and no money ever moved on it: the Network lets these go. */
const DELETABLE: BookingStatus[] = ['declined', 'cancelled', 'accepted'];

function amountText(b: CreatorBooking): string {
  if (b.amountMinor != null && b.currency) return formatMinor(b.amountMinor, b.currency);
  if (b.amount != null && b.currency) return formatWholeAmount(b.amount, b.currency);
  return b.package?.priceAmount != null ? `From ${formatWholeAmount(b.package.priceAmount, b.package.currency)}` : 'Price to agree';
}

export function CreatorBookingsPage() {
  const qc = useQueryClient();
  const [filter, setFilter] = useState<BookingStatus | 'all'>('pending');
  const list = useQuery({
    queryKey: ['creator-bookings', filter],
    queryFn: () => creatorApi<{ bookings: CreatorBooking[] }>(`/creators/me/bookings${filter === 'all' ? '' : `?status=${filter}`}`),
    retry: false,
  });
  const remove = useMutation({
    mutationFn: (id: string) => creatorApi(`/creators/me/bookings/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['creator-bookings'] }),
  });
  const decline = useMutation({
    mutationFn: (id: string) => creatorApi(`/creators/me/bookings/${encodeURIComponent(id)}/decline`, { method: 'POST', body: {} }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['creator-bookings'] }),
  });

  return (
    <Page title="Bookings" subtitle="Requests and offers from your storefront. Answer, deliver and refund them in Messages.">
      <div style={{ display: 'flex', gap: 6, marginBottom: 14, flexWrap: 'wrap' }}>
        {FILTERS.map((f) => (
          <Button key={f.key} size="sm" variant={filter === f.key ? 'primary' : 'secondary'} onClick={() => setFilter(f.key)}>
            {f.label}
          </Button>
        ))}
      </div>
      <ErrorBanner error={list.error ?? remove.error ?? decline.error} />
      {list.isLoading ? (
        <Card>Loading…</Card>
      ) : !list.data || list.data.bookings.length === 0 ? (
        <EmptyState
          title="Nothing here"
          hint="When a brand requests one of your packages, or you send one an offer, it shows up here and in Messages."
          icon={<Inbox size={28} strokeWidth={1.25} />}
        />
      ) : (
        <Card padded={false}>
          {list.data.bookings.map((b, i) => (
            <div key={b.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', borderTop: i === 0 ? 'none' : `1px solid ${theme.borderSubtle}`, flexWrap: 'wrap' }}>
              <div style={{ flex: 1, minWidth: 220 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 14, fontWeight: 500 }}>{b.package?.title ?? 'Custom collaboration'}</span>
                  <BookingStatusPill status={b.status} />
                </div>
                <div style={{ fontSize: 13, color: theme.textMuted, marginTop: 2 }}>
                  {b.contactName}
                  {b.company ? ` · ${b.company}` : ''} · {formatDate(b.createdAt)}
                </div>
                {!b.conversationId && b.status === 'pending' && (
                  <div style={{ fontSize: 12, color: theme.textDim, marginTop: 4 }}>
                    An older request from your public page, with no brand account behind it, so it can&rsquo;t be booked here. Decline it,
                    or ask them to send it again from your page, which now sets them up to book and pay.
                  </div>
                )}
              </div>
              <div style={{ fontSize: 14, fontWeight: 600 }}>{amountText(b)}</div>
              {b.conversationId ? (
                <Link to={`/creator/messages/${b.conversationId}`} style={{ textDecoration: 'none' }}>
                  <Button size="sm" variant="secondary">Open</Button>
                </Link>
              ) : b.status === 'pending' ? (
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={decline.isPending}
                  onClick={() => {
                    if (window.confirm('Decline this request?')) decline.mutate(b.id);
                  }}
                >
                  Decline
                </Button>
              ) : (
                DELETABLE.includes(b.status) && (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={remove.isPending}
                    onClick={() => {
                      if (window.confirm('Delete this request for good?')) remove.mutate(b.id);
                    }}
                  >
                    Delete
                  </Button>
                )
              )}
            </div>
          ))}
        </Card>
      )}
    </Page>
  );
}
