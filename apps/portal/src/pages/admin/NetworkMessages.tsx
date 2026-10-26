/**
 * Network → Messages: the brand's conversations with creators (the Network's
 * docs/creator-storefront.md §8). Talk before booking; a booking lives in the
 * thread as a card: the creator accepts at a price (or sends an offer), you
 * pay upfront through Stripe Checkout on the creator's own account, they
 * deliver, you approve.
 *
 *   /admin/network/messages        the list
 *   /admin/network/messages/:id    one conversation
 *
 * Coming back from Checkout (?booking=…&checkout=success) records the
 * payment straight away rather than waiting for Stripe's webhook.
 *
 * An open thread is live (conversation-live.ts): the creator's presence,
 * "is typing…", and new messages as they land. It still polls, slowly while
 * the socket is up.
 */
import { useEffect, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MessagesSquare } from 'lucide-react';
import { api, ApiError } from '../../api.js';
import { Button, Card, EmptyState, ErrorBanner, Page, Select, formatDate } from '../../ui.js';
import { alpha, theme } from '../../theme.js';
import { TenantLink } from '../../tenant-link.js';
import { useTenantBase } from '../../tenant-base.js';
import { useConversationLive, type LiveTicket } from '../creator/conversation-live.js';
import {
  BookingStatusPill,
  Composer,
  Face,
  PresenceBadge,
  Thread,
  TypingNote,
  UnreadDot,
  formatMinor,
  formatWholeAmount,
  previewLine,
  timeLabel,
  type BookingStatus,
  type ConversationMessage,
  type LastMessage,
} from '../creator/conversation-shared.js';
import { ClaimError, fetchClaimPreview } from '../creator/BookingConfirm.js';
import { BookCreatorDialog, networkErrorCode } from './BookCreatorDialog.js';
import { DeliveryChecksPanel, type DeliveryChecks } from './DeliveryChecks.js';

interface CreatorFace {
  id: string;
  name: string;
  handle: string | null;
  avatarUrl: string | null;
}

interface ConversationSummary {
  id: string;
  creator: CreatorFace | null;
  blocked: boolean;
  lastMessageAt: string;
  lastMessage: LastMessage | null;
  unread: number;
  openBookings: number;
}

export interface VendorBooking {
  id: string;
  conversationId: string | null;
  proposedBy: 'vendor' | 'creator';
  status: BookingStatus;
  creator: CreatorFace | null;
  package: { title: string; priceAmount: number | null; priceIsFrom: boolean; currency: string } | null;
  offering: { id: string; title: string } | null;
  brief: string;
  amount: number | null;
  currency: string | null;
  feeRateBps: number | null;
  amountMinor: number | null;
  feeMinor: number | null;
  totalMinor: number | null;
  creatorMessage: string | null;
  deliverableUrls: string[];
  partnerId: string | null;
  createdAt: string;
  paidAt: string | null;
  /** Checkout finished but the payment hasn't settled (bank debits). */
  paymentProcessing?: boolean;
  deliveredAt: string | null;
  completedAt: string | null;
  refundedMinor: number;
  disputedAt: string | null;
  deliveryChecks?: DeliveryChecks | null;
}

interface VendorThread {
  conversation: {
    id: string;
    creator: CreatorFace | null;
    blocked: boolean;
    canWrite: boolean;
    cannotWriteReason: string | null;
    canBook: boolean;
    /** Older Networks don't say; tracking is then offered and the gates decide. */
    canTrack?: boolean;
  };
  messages: ConversationMessage[];
  hasMore: boolean;
  bookings: VendorBooking[];
}

const CANNOT_WRITE: Record<string, string> = {
  conversation_blocked: 'This creator isn’t taking messages from you.',
  creator_unavailable: 'This creator is no longer on the Network.',
  vendor_rejected: 'Your brand can’t message creators.',
};

const ACTION_ERRORS: Record<string, string> = {
  payments_not_ready: 'The creator’s Stripe account can’t take payments right now. Ask them to check their payment settings.',
  conversation_blocked: 'This creator isn’t taking messages or bookings from you.',
  not_awaiting_payment: 'This booking isn’t waiting for payment any more.',
  already_paid: 'This booking is already paid.',
  payment_processing: 'Your payment is still processing. This updates once it’s through.',
  amount_too_large: 'That amount is too large to charge in one payment.',
  creator_unavailable: 'This creator is no longer on the Network.',
  vendor_rejected: 'Your brand can’t book creators.',
  not_cancellable: 'This booking can’t be cancelled now.',
  not_delivered: 'The creator hasn’t delivered yet.',
  plan_required: 'Tracking a booking adds the creator as your partner, which needs an active plan.',
  partnership_ended: 'This creator’s earlier partnership on that offering ended. Invite them to it again from Discover creators.',
  rate_limited: 'You’re sending messages very quickly. Wait a little and try again.',
  brand_pending_review: 'Your brand is still being reviewed. You can do this once it’s approved.',
  vendor_pending_review: 'Your brand is still being reviewed. You can do this once it’s approved.',
};

function errorText(err: unknown): unknown {
  const code = networkErrorCode(err) ?? (err instanceof ApiError ? err.message : null);
  return code && ACTION_ERRORS[code] ? ACTION_ERRORS[code] : err;
}

export function AdminNetworkMessages() {
  const list = useQuery({
    queryKey: ['admin-network-conversations'],
    queryFn: () => api<{ conversations: ConversationSummary[]; unreadTotal: number }>('/admin/network/conversations'),
    refetchInterval: 30_000,
  });
  return (
    <Page
      title="Messages"
      subtitle="Your conversations with creators. Agree the details here, then book and pay in the thread."
      actions={
        <TenantLink to="/admin/network/creators" style={{ textDecoration: 'none' }}>
          <Button variant="secondary">Discover creators</Button>
        </TenantLink>
      }
    >
      <ErrorBanner error={list.error} />
      {list.isLoading ? (
        <Card>Loading…</Card>
      ) : !list.data || list.data.conversations.length === 0 ? (
        <EmptyState
          title="No conversations yet"
          hint="Open a creator’s storefront under Discover creators and send them a message or a booking request."
          icon={<MessagesSquare size={28} strokeWidth={1.25} />}
        />
      ) : (
        <Card padded={false}>
          {list.data.conversations.map((c, i) => (
            <TenantLink
              key={c.id}
              to={`/admin/network/messages/${c.id}`}
              style={{
                display: 'flex',
                gap: 12,
                alignItems: 'center',
                padding: '12px 16px',
                textDecoration: 'none',
                color: theme.text,
                borderTop: i === 0 ? 'none' : `1px solid ${theme.borderSubtle}`,
              }}
            >
              <Face name={c.creator?.name ?? '?'} src={c.creator?.avatarUrl} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 14, fontWeight: c.unread > 0 ? 600 : 500 }}>{c.creator?.name ?? 'Creator removed'}</span>
                  {c.openBookings > 0 && (
                    <span style={{ fontSize: 11, color: theme.textMuted, border: `1px solid ${theme.borderSubtle}`, borderRadius: 999, padding: '1px 7px' }}>
                      {c.openBookings} open {c.openBookings === 1 ? 'booking' : 'bookings'}
                    </span>
                  )}
                </div>
                <div style={{ fontSize: 13, color: theme.textMuted, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {previewLine(c.lastMessage, 'vendor', { creator: c.creator?.name ?? 'Creator', brand: 'Your brand' })}
                </div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
                <span style={{ fontSize: 12, color: theme.textDim }}>{timeLabel(c.lastMessageAt)}</span>
                <UnreadDot count={c.unread} />
              </div>
            </TenantLink>
          ))}
        </Card>
      )}
    </Page>
  );
}

export function AdminNetworkThread() {
  const { id = '' } = useParams();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const [older, setOlder] = useState<ConversationMessage[]>([]);
  const [olderHasMore, setOlderHasMore] = useState<boolean | null>(null);
  const [booking, setBooking] = useState(false);
  const [returned, setReturned] = useState<string | null>(null);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['admin-network-thread', id] });
    void qc.invalidateQueries({ queryKey: ['admin-network-conversations'] });
  };
  // Live: the creator's presence and typing, and new messages at once.
  const live = useConversationLive(
    id,
    'vendor',
    () => api<LiveTicket>(`/admin/network/conversations/${encodeURIComponent(id)}/realtime`, { method: 'POST', body: {} }),
    refresh,
  );
  const thread = useQuery({
    queryKey: ['admin-network-thread', id],
    queryFn: () => api<VendorThread>(`/admin/network/conversations/${encodeURIComponent(id)}`),
    refetchInterval: live.connected ? 60_000 : 10_000,
  });

  // Back from Stripe Checkout: record the payment now, then tidy the URL.
  useEffect(() => {
    const bookingId = params.get('booking');
    const outcome = params.get('checkout');
    if (!bookingId || !outcome) return;
    const next = new URLSearchParams(params);
    next.delete('booking');
    next.delete('checkout');
    setParams(next, { replace: true });
    if (outcome !== 'success') return;
    setReturned(bookingId);
    void api(`/admin/network/bookings/${encodeURIComponent(bookingId)}/sync`, { method: 'POST', body: {} })
      .catch(() => undefined)
      .finally(refresh);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const send = useMutation({
    mutationFn: (body: string) => api(`/admin/network/conversations/${encodeURIComponent(id)}/messages`, { method: 'POST', body: { body } }),
    onSuccess: refresh,
  });
  const earlier = useMutation({
    mutationFn: (before: string) =>
      api<VendorThread>(`/admin/network/conversations/${encodeURIComponent(id)}?before=${encodeURIComponent(before)}`),
    onSuccess: (page) => {
      setOlder((prev) => [...page.messages, ...prev]);
      setOlderHasMore(page.hasMore);
    },
  });

  if (thread.isLoading) return <Page title="Messages"><Card>Loading…</Card></Page>;
  if (!thread.data) {
    return (
      <Page title="Messages">
        <ErrorBanner error={thread.error ?? 'This conversation isn’t available.'} />
      </Page>
    );
  }
  const t = thread.data;
  const creator = t.conversation.creator;
  const names = { creator: creator?.name ?? 'The creator', brand: 'You' };
  const messages = [...older, ...t.messages];
  const bookings = new Map(t.bookings.map((b) => [b.id, b]));
  // Back from Checkout: say what the booking says, not what the return URL does.
  const back = returned ? bookings.get(returned) : undefined;
  const banner = !back
    ? null
    : back.status === 'paid'
      ? { tone: 'success' as const, text: `Payment received. ${names.creator} has been told, and can start now.` }
      : back.status === 'refunded'
        ? { tone: 'info' as const, text: `${names.creator} has refunded this booking.` }
        : back.status === 'awaiting_payment'
          ? {
              tone: 'info' as const,
              text: back.paymentProcessing
                ? 'Your payment is processing. Bank payments can take a few days; the booking is confirmed once it’s through.'
                : 'We’re confirming your payment with Stripe. This page updates once it’s through.',
            }
          : null;

  return (
    <Page
      title={creator?.name ?? 'Conversation'}
      subtitle={creator?.handle ? `@${creator.handle}` : undefined}
      actions={
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {creator?.handle && (
            <TenantLink to={`/admin/network/creators/${encodeURIComponent(creator.handle)}`} style={{ textDecoration: 'none' }}>
              <Button variant="secondary">Storefront</Button>
            </TenantLink>
          )}
          {t.conversation.canBook && creator?.handle && <Button onClick={() => setBooking(true)}>Request a booking</Button>}
        </div>
      }
    >
      <div style={{ marginBottom: 10, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <TenantLink to="/admin/network/messages" style={{ fontSize: 13, color: theme.accentText }}>
          ← All messages
        </TenantLink>
        <PresenceBadge online={live.otherOnline} />
      </div>
      {banner && (
        <div
          role="status"
          style={{
            background: banner.tone === 'success' ? theme.successSoft : theme.surface2,
            border: `1px solid ${banner.tone === 'success' ? alpha(theme.success, 0.333) : theme.borderSubtle}`,
            color: banner.tone === 'success' ? theme.success : theme.textMuted,
            borderRadius: theme.radiusSm,
            padding: '10px 12px',
            fontSize: 13,
            marginBottom: 12,
          }}
        >
          {banner.text}
        </div>
      )}
      <Card>
        <Thread
          messages={messages}
          side="vendor"
          names={names}
          hasMore={olderHasMore ?? t.hasMore}
          loadingEarlier={earlier.isPending}
          onLoadEarlier={() => messages[0] && earlier.mutate(messages[0].id)}
          renderBooking={(bookingId) => {
            const b = bookings.get(bookingId);
            return b ? (
              <VendorBookingCard booking={b} creatorName={names.creator} canTrack={t.conversation.canTrack ?? true} onChanged={refresh} />
            ) : null;
          }}
        />
        <TypingNote name={live.typing} />
        <div style={{ marginTop: 8, borderTop: `1px solid ${theme.borderSubtle}`, paddingTop: 14 }}>
          <ErrorBanner error={send.error ? errorText(send.error) : null} />
          <Composer
            onSend={(body) => send.mutateAsync(body)}
            pending={send.isPending}
            disabledReason={t.conversation.canWrite ? null : CANNOT_WRITE[t.conversation.cannotWriteReason ?? ''] ?? 'You can’t write here.'}
            placeholder={`Message ${names.creator}`}
            onTyping={live.setTyping}
          />
        </div>
      </Card>
      {booking && creator?.handle && (
        <BookCreatorDialog
          creator={{ id: creator.id, name: creator.name, handle: creator.handle }}
          onClose={() => {
            setBooking(false);
            refresh();
          }}
        />
      )}
    </Page>
  );
}

function priceLines(b: VendorBooking): { price: string; fee: string; total: string } | null {
  if (b.amountMinor == null || b.feeMinor == null || b.totalMinor == null || !b.currency) return null;
  return { price: formatMinor(b.amountMinor, b.currency), fee: formatMinor(b.feeMinor, b.currency), total: formatMinor(b.totalMinor, b.currency) };
}

function VendorBookingCard({
  booking: b,
  creatorName,
  canTrack,
  onChanged,
}: {
  booking: VendorBooking;
  creatorName: string;
  canTrack: boolean;
  onChanged: () => void;
}) {
  const base = useTenantBase();
  const act = useMutation({
    mutationFn: (action: 'cancel' | 'approve' | 'recheck') =>
      api(`/admin/network/bookings/${encodeURIComponent(b.id)}/${action}`, { method: 'POST', body: {} }),
    onSuccess: onChanged,
  });
  const pay = useMutation({
    mutationFn: () =>
      api<{ url: string }>(`/admin/network/bookings/${encodeURIComponent(b.id)}/checkout`, {
        method: 'POST',
        body: { returnPath: b.conversationId ? `/admin/network/messages/${b.conversationId}` : '/admin/network/bookings' },
      }),
    onSuccess: (r) => window.location.assign(r.url),
  });
  const lines = priceLines(b);
  const title = b.package?.title ?? 'Custom collaboration';
  const error = act.error ?? pay.error;

  return (
    <div style={{ border: `1px solid ${theme.border}`, borderRadius: theme.radiusSm, padding: 14, background: theme.surface }}>
      <ErrorBanner error={error ? errorText(error) : null} />
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 200 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 15, fontWeight: 500 }}>{title}</span>
            <BookingStatusPill status={b.status} />
            {b.proposedBy === 'creator' && <span style={{ fontSize: 12, color: theme.textDim }}>offer from {creatorName}</span>}
          </div>
          {b.offering && <div style={{ fontSize: 12, color: theme.textMuted, marginTop: 3 }}>Tracked on {b.offering.title}</div>}
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: 15, fontWeight: 600 }}>
            {b.amount != null && b.currency ? formatWholeAmount(b.amount, b.currency) : 'Price to agree'}
          </div>
          {lines && b.status === 'awaiting_payment' && (
            <div style={{ fontSize: 12, color: theme.textDim, marginTop: 2 }}>+ {lines.fee} booking fee</div>
          )}
        </div>
      </div>
      <div style={{ fontSize: 13, color: theme.textMuted, marginTop: 10, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{b.brief}</div>

      {b.deliverableUrls.length > 0 && (
        <DeliveryChecksPanel
          urls={b.deliverableUrls}
          checks={b.deliveryChecks}
          onRecheck={() => act.mutate('recheck')}
          rechecking={act.isPending && act.variables === 'recheck'}
        />
      )}

      <div style={{ fontSize: 13, color: theme.textMuted, marginTop: 10 }}>
        {b.status === 'pending' && <>Waiting for {creatorName} to accept and name the price.</>}
        {b.status === 'awaiting_payment' && b.paymentProcessing && (
          <>Payment processing. Bank payments can take a few days; the booking is confirmed once it&rsquo;s through.</>
        )}
        {b.status === 'awaiting_payment' && !b.paymentProcessing && lines && (
          <>
            You pay <strong style={{ color: theme.text }}>{lines.total}</strong>: {lines.price} to {creatorName} and the {lines.fee} OpenPartner booking fee. The
            booking is confirmed once you pay, and {creatorName} starts then. Payment goes to {creatorName}&rsquo;s own Stripe account.
          </>
        )}
        {b.status === 'paid' && <>Paid {formatDate(b.paidAt)}. {creatorName} is working on it and marks it delivered once it&rsquo;s live.</>}
        {b.status === 'delivered' && <>Delivered {formatDate(b.deliveredAt)}. Approve it once you&rsquo;re happy; it completes by itself after 14 days.</>}
        {b.status === 'completed' && <>Completed {formatDate(b.completedAt)}.</>}
        {b.status === 'refunded' && b.currency && <>Refunded {formatMinor(b.refundedMinor, b.currency)}, booking fee included.</>}
        {b.status !== 'refunded' && b.refundedMinor > 0 && b.currency && <> {formatMinor(b.refundedMinor, b.currency)} refunded so far.</>}
        {b.disputedAt && <> The payment is disputed with your card issuer.</>}
      </div>

      <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        {b.status === 'awaiting_payment' && !b.paymentProcessing && (
          <Button onClick={() => pay.mutate()} disabled={pay.isPending || pay.isSuccess}>
            {pay.isPending || pay.isSuccess ? 'Opening Checkout…' : `Pay ${lines?.total ?? ''}`.trim()}
          </Button>
        )}
        {b.status === 'delivered' && (
          <Button
            disabled={act.isPending}
            onClick={() => {
              if (window.confirm(`Approve ${creatorName}’s work? This completes the booking.`)) act.mutate('approve');
            }}
          >
            Approve
          </Button>
        )}
        {(b.status === 'pending' || (b.status === 'awaiting_payment' && !b.paymentProcessing)) && (
          <Button
            variant="secondary"
            disabled={act.isPending}
            onClick={() => {
              const offer = b.proposedBy === 'creator';
              if (window.confirm(offer ? 'Decline this offer? The creator is told.' : 'Cancel this request? The creator is told.')) act.mutate('cancel');
            }}
          >
            {b.proposedBy === 'creator' ? 'Decline offer' : 'Cancel request'}
          </Button>
        )}
        <div style={{ flex: 1 }} />
        {b.partnerId ? (
          <TenantLink to={`/admin/partners/${b.partnerId}/commission`} style={{ fontSize: 13, color: theme.accentText }}>
            Partner &amp; results
          </TenantLink>
        ) : (
          canTrack &&
          ['awaiting_payment', 'paid', 'delivered'].includes(b.status) && <TrackControl booking={b} onTracked={onChanged} billingHref={`${base}/admin/billing`} />
        )}
      </div>
    </div>
  );
}

/** Make the booking a tracked deal on one of your offerings: the creator
 *  becomes your partner there, with a link you can measure. */
function TrackControl({ booking, onTracked, billingHref }: { booking: VendorBooking; onTracked: () => void; billingHref: string }) {
  const [open, setOpen] = useState(false);
  const [offeringId, setOfferingId] = useState('');
  const offerings = useQuery({
    queryKey: ['admin-network-offerings'],
    queryFn: () => api<{ offerings: Array<{ id: string; title: string; published: boolean }> }>('/admin/network/offerings'),
    enabled: open,
  });
  const track = useMutation({
    mutationFn: () => api(`/admin/network/bookings/${encodeURIComponent(booking.id)}/track`, { method: 'POST', body: { offeringId } }),
    onSuccess: () => {
      setOpen(false);
      onTracked();
    },
  });
  const planNeeded = (networkErrorCode(track.error) ?? (track.error instanceof ApiError ? track.error.message : '')) === 'plan_required';
  if (!open) {
    return (
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
        Track with a program
      </Button>
    );
  }
  const published = (offerings.data?.offerings ?? []).filter((o) => o.published);
  return (
    <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
      {planNeeded ? (
        <span style={{ fontSize: 13, color: theme.textMuted }}>
          Tracking adds {booking.creator?.name ?? 'the creator'} as your partner, which needs an active plan.{' '}
          <a href={billingHref} style={{ color: theme.accentText }}>Choose a plan</a>
        </span>
      ) : (
        <>
          <Select value={offeringId} onChange={(e) => setOfferingId(e.target.value)} aria-label="Offering">
            <option value="">{published.length ? 'Pick an offering' : 'No published offerings'}</option>
            {published.map((o) => (
              <option key={o.id} value={o.id}>{o.title}</option>
            ))}
          </Select>
          <Button size="sm" disabled={!offeringId || track.isPending} onClick={() => track.mutate()}>
            Track
          </Button>
          {track.error && !planNeeded && (
            <span style={{ fontSize: 12, color: theme.danger }}>
              {typeof errorText(track.error) === 'string' ? (errorText(track.error) as string) : 'Couldn’t track it. Try again.'}
            </span>
          )}
        </>
      )}
      <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
        Close
      </Button>
    </div>
  );
}

const CLAIM_ERRORS: Record<string, string> = {
  invalid_or_used: 'This request has already been sent, or the link isn’t valid.',
  expired: 'This link has expired. Send your request again from the creator’s page.',
  creator_unavailable: 'This creator isn’t taking bookings right now.',
  vendor_rejected: 'Your brand can’t book creators.',
  vendor_pending_review: 'Your brand is still being reviewed. Until it’s approved, it can talk to one creator only.',
  conversation_blocked: 'This creator isn’t taking requests from your brand.',
  too_many_open_bookings: 'You already have the maximum of 3 open bookings with this creator.',
  rate_limited: 'Your brand has started a lot of conversations today. Try again tomorrow.',
  network_not_configured: 'Your brand isn’t connected to the OpenPartner Network yet.',
};

/** /admin/network/claim?token=… — where a public request continues for a
 *  signed-in brand (the landing page /booking/confirm sends them here). It
 *  shows the request, and sends it as this brand only on a click: the link
 *  may have come from someone else's inbox. */
export function AdminNetworkClaim() {
  const [params] = useSearchParams();
  const nav = useNavigate();
  const base = useTenantBase();
  const token = params.get('token') ?? '';
  const preview = useQuery({
    queryKey: ['booking-claim-preview', token],
    queryFn: () => fetchClaimPreview(token),
    enabled: !!token,
    retry: false,
  });
  const claim = useMutation({
    mutationFn: () => api<{ conversationId: string }>('/admin/network/bookings/claim', { method: 'POST', body: { token } }),
    onSuccess: (r) => nav(`${base}/admin/network/messages/${r.conversationId}`, { replace: true }),
  });
  const code = networkErrorCode(claim.error) ?? (claim.error instanceof ApiError ? claim.error.message : null);
  const previewCode = preview.error instanceof ClaimError ? preview.error.code : null;
  const p = preview.data;
  return (
    <Page title="Send your request">
      <Card>
        {!token ? (
          <div style={{ fontSize: 14, color: theme.textMuted }}>This link is missing its request.</div>
        ) : claim.isError || preview.isError ? (
          <>
            <ErrorBanner
              error={
                claim.isError
                  ? code && CLAIM_ERRORS[code]
                    ? CLAIM_ERRORS[code]
                    : claim.error
                  : (previewCode && CLAIM_ERRORS[previewCode]) || 'This request can’t be loaded. Try again in a moment.'
              }
            />
            <TenantLink to="/admin/network/messages" style={{ fontSize: 13, color: theme.accentText }}>
              Go to your messages
            </TenantLink>
          </>
        ) : !p ? (
          <div style={{ fontSize: 14, color: theme.textMuted }}>Loading…</div>
        ) : (
          <>
            <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
              <Face name={p.creator.name} src={p.creator.avatarUrl} />
              <div>
                <div style={{ fontSize: 15, fontWeight: 500 }}>To {p.creator.name}</div>
                {p.packageTitle && <div style={{ fontSize: 13, color: theme.textMuted }}>For {p.packageTitle}</div>}
              </div>
            </div>
            <blockquote
              style={{
                borderLeft: `3px solid ${theme.border}`,
                margin: '14px 0 0',
                padding: '2px 0 2px 12px',
                fontSize: 13,
                color: theme.textMuted,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}
            >
              {p.brief}
            </blockquote>
            <div style={{ fontSize: 13, color: theme.textMuted, margin: '14px 0', lineHeight: 1.5 }}>
              It goes out from your brand, under your name, and opens a conversation with {p.creator.name.split(' ')[0]} in Messages.
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <Button onClick={() => claim.mutate()} disabled={claim.isPending || claim.isSuccess}>
                {claim.isPending || claim.isSuccess ? 'Sending…' : 'Send as your brand'}
              </Button>
              <TenantLink to="/admin/network/messages" style={{ textDecoration: 'none' }}>
                <Button variant="secondary">Not now</Button>
              </TenantLink>
            </div>
          </>
        )}
      </Card>
    </Page>
  );
}

/** Start (or continue) a conversation with a creator from their storefront. */
export function MessageCreatorDialog({ creator, onClose }: { creator: { id: string; name: string }; onClose: () => void }) {
  const nav = useNavigate();
  const base = useTenantBase();
  const start = useMutation({
    mutationFn: (body: string) =>
      api<{ conversationId: string }>('/admin/network/conversations', { method: 'POST', body: { creatorId: creator.id, body } }),
    onSuccess: (r) => nav(`${base}/admin/network/messages/${r.conversationId}`),
  });
  const code = networkErrorCode(start.error) ?? (start.error instanceof ApiError ? start.error.message : null);
  const text: Record<string, string> = {
    brand_pending_review: 'Your brand is still being reviewed. You can message creators once it’s approved.',
    vendor_pending_review: 'Your brand is still being reviewed. You can message creators once it’s approved.',
    bookings_closed: `${creator.name} isn’t taking bookings or messages right now.`,
    conversation_blocked: `${creator.name} isn’t taking messages from your brand.`,
    rate_limited: 'You’ve started a lot of conversations today. Try again tomorrow.',
  };
  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{ position: 'fixed', inset: 0, background: theme.overlay, display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50 }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div style={{ background: theme.surface, border: `1px solid ${theme.borderSubtle}`, borderRadius: theme.radiusSm, padding: 24, maxWidth: 520, width: '92%' }}>
        <div style={{ fontSize: 15, fontWeight: 500, marginBottom: 4 }}>Message {creator.name}</div>
        <p style={{ fontSize: 13, color: theme.textMuted, margin: '0 0 14px', lineHeight: 1.5 }}>
          Ask about dates, formats or a custom deal. {creator.name} answers here on OpenPartner, and we don&rsquo;t share your email address with them.
        </p>
        <ErrorBanner error={start.error ? (code && text[code] ? text[code] : start.error) : null} />
        <Composer onSend={(body) => start.mutateAsync(body)} pending={start.isPending} placeholder={`Hi ${creator.name.split(' ')[0]}, …`} />
        <div style={{ marginTop: 10 }}>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
        </div>
      </div>
    </div>
  );
}

/** Unread messages across the brand's conversations, for the sidebar. */
export function useBrandUnreadMessages(enabled: boolean): number {
  const q = useQuery({
    queryKey: ['admin-network-conversations'],
    queryFn: () => api<{ conversations: ConversationSummary[]; unreadTotal: number }>('/admin/network/conversations'),
    enabled,
    refetchInterval: 60_000,
    retry: false,
  });
  return q.data?.unreadTotal ?? 0;
}
