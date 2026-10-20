/**
 * /creator/bookings — booking requests brands sent from the creator's
 * storefront. Only confirmed requests show (the requester proved their
 * email first). Accepting emails the brand with Reply-To set to the
 * creator, so the deal continues over email; declining doesn't reveal the
 * creator's address.
 */
import { useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Inbox } from 'lucide-react';
import { Button, Card, EmptyState, ErrorBanner, Label, Page, StatusPill, Textarea, formatDate } from '../../ui.js';
import { theme } from '../../theme.js';
import { creatorApi } from './creator-api.js';
import { formatPackagePrice } from './storefront-shared.js';

type BookingStatus = 'pending' | 'accepted' | 'declined';

interface Booking {
  id: string;
  packageId: string | null;
  package: { title: string; priceAmount: number | null; priceIsFrom: boolean; currency: string; platform: string | null } | null;
  contactName: string;
  contactEmail: string;
  company: string | null;
  website: string | null;
  brief: string;
  budgetNote: string | null;
  status: BookingStatus;
  creatorMessage: string | null;
  createdAt: string;
  confirmedAt: string | null;
  respondedAt: string | null;
}

const FILTERS: Array<{ key: BookingStatus | 'all'; label: string }> = [
  { key: 'pending', label: 'Pending' },
  { key: 'accepted', label: 'Accepted' },
  { key: 'declined', label: 'Declined' },
  { key: 'all', label: 'All' },
];

export function CreatorBookingsPage() {
  const [filter, setFilter] = useState<BookingStatus | 'all'>('pending');
  const list = useQuery({
    queryKey: ['creator-bookings', filter],
    queryFn: () =>
      creatorApi<{ bookings: Booking[] }>(`/creators/me/bookings${filter === 'all' ? '' : `?status=${filter}`}`),
    retry: false,
  });

  return (
    <Page
      title="Bookings"
      subtitle="Requests brands sent from your storefront."
      actions={
        <Link to="/creator/storefront" style={{ textDecoration: 'none' }}>
          <Button variant="secondary">Edit storefront</Button>
        </Link>
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
          title={filter === 'pending' ? 'No pending requests' : 'Nothing here'}
          hint="Turn on bookings in your storefront and share your public profile link — requests land here."
          icon={<Inbox size={28} strokeWidth={1.25} />}
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

function BookingCard({ booking: b }: { booking: Booking }) {
  const qc = useQueryClient();
  const [answering, setAnswering] = useState<'accept' | 'decline' | null>(null);
  const [message, setMessage] = useState('');
  const invalidate = () => qc.invalidateQueries({ queryKey: ['creator-bookings'] });

  const respond = useMutation({
    mutationFn: (outcome: 'accept' | 'decline') =>
      creatorApi(`/creators/me/bookings/${b.id}/${outcome}`, { method: 'POST', body: { message: message.trim() || null } }),
    onSuccess: () => {
      setAnswering(null);
      setMessage('');
      invalidate();
    },
  });
  const remove = useMutation({
    mutationFn: () => creatorApi(`/creators/me/bookings/${b.id}`, { method: 'DELETE' }),
    onSuccess: invalidate,
  });

  const safeWebsite = b.website && /^https?:\/\//i.test(b.website) ? b.website : null;
  const from = b.company ? `${b.contactName} · ${b.company}` : b.contactName;

  return (
    <Card>
      <ErrorBanner error={respond.error ?? remove.error} />
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 220 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 15, fontWeight: 500 }}>{b.package?.title ?? 'Custom collaboration'}</span>
            <StatusPill status={b.status} />
          </div>
          <div style={{ fontSize: 13, color: theme.textMuted, marginTop: 4 }}>
            {from} ·{' '}
            <a href={`mailto:${b.contactEmail}`} style={{ color: theme.accentText }}>{b.contactEmail}</a>
            {safeWebsite && (
              <>
                {' '}·{' '}
                <a href={safeWebsite} target="_blank" rel="noopener noreferrer nofollow" style={{ color: theme.accentText }}>
                  {safeWebsite.replace(/^https?:\/\//i, '')}
                </a>
              </>
            )}
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          {b.package && <div style={{ fontSize: 14, fontWeight: 600 }}>{formatPackagePrice(b.package)}</div>}
          <div style={{ fontSize: 12, color: theme.textDim, marginTop: 2 }}>{formatDate(b.confirmedAt ?? b.createdAt)}</div>
        </div>
      </div>

      {b.budgetNote && (
        <div style={{ fontSize: 13, marginTop: 10 }}>
          <span style={{ color: theme.textMuted }}>Budget:</span> {b.budgetNote}
        </div>
      )}
      <div
        style={{
          fontSize: 14,
          marginTop: 10,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          background: theme.surface2,
          border: `1px solid ${theme.borderSubtle}`,
          borderRadius: theme.radiusSm,
          padding: '10px 12px',
        }}
      >
        {b.brief}
      </div>

      {b.creatorMessage && (
        <div style={{ fontSize: 13, color: theme.textMuted, marginTop: 10, whiteSpace: 'pre-wrap' }}>
          Your reply: {b.creatorMessage}
        </div>
      )}

      {b.status === 'pending' && answering && (
        <div style={{ marginTop: 14 }}>
          <Label>{answering === 'accept' ? 'Message to the brand (optional)' : 'Note to the brand (optional)'}</Label>
          <Textarea
            value={message}
            rows={3}
            maxLength={1000}
            onChange={(e) => setMessage(e.target.value)}
            placeholder={
              answering === 'accept'
                ? 'Thanks — happy to do this. My next free slot is…'
                : 'Thanks for reaching out — this one isn’t a fit for my audience.'
            }
          />
          <div style={{ fontSize: 12, color: theme.textDim, marginTop: 6 }}>
            {answering === 'accept'
              ? `We email ${b.contactEmail}; their reply comes straight to your email.`
              : `We email ${b.contactEmail}. Your email address isn’t shared.`}
          </div>
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
        {b.status === 'pending' ? (
          answering ? (
            <>
              <Button
                variant={answering === 'accept' ? 'primary' : 'danger'}
                disabled={respond.isPending}
                onClick={() => respond.mutate(answering)}
              >
                {respond.isPending ? 'Sending…' : answering === 'accept' ? 'Accept & email brand' : 'Decline & email brand'}
              </Button>
              <Button variant="secondary" onClick={() => setAnswering(null)}>Cancel</Button>
            </>
          ) : (
            <>
              <Button onClick={() => setAnswering('accept')}>Accept</Button>
              <Button variant="secondary" onClick={() => setAnswering('decline')}>Decline</Button>
            </>
          )
        ) : (
          <>
            <a href={`mailto:${b.contactEmail}`} style={{ textDecoration: 'none' }}>
              <Button variant="secondary" size="sm">Email {b.contactName.split(' ')[0]}</Button>
            </a>
            <div style={{ flex: 1 }} />
            <Button
              size="sm"
              variant="ghost"
              disabled={remove.isPending}
              onClick={() => {
                if (window.confirm('Delete this request? This can’t be undone.')) remove.mutate();
              }}
            >
              Delete
            </Button>
          </>
        )}
      </div>
    </Card>
  );
}
