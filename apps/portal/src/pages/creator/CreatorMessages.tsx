/**
 * The creator's Messages (the Network's docs/creator-storefront.md §8):
 * conversations with brands, each with its bookings as cards. Accept a
 * request at your price or decline it, send your own offer, then deliver
 * once the brand has paid. Payment lands in your own Stripe account; you can
 * refund from here or from your Stripe Dashboard.
 *
 *   /creator/messages        the list
 *   /creator/messages/:id    one conversation
 */
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MessagesSquare } from 'lucide-react';
import { Button, Card, EmptyState, ErrorBanner, Input, Label, Page, Select, Textarea, formatDate } from '../../ui.js';
import { theme } from '../../theme.js';
import { creatorApi } from './creator-api.js';
import { creatorErrorCode, usePayments } from './CreatorPayments.js';
import { PACKAGE_CURRENCIES, type OwnPackage } from './storefront-shared.js';
import { useConversationLive, type LiveTicket } from './conversation-live.js';
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
} from './conversation-shared.js';

interface BrandFace {
  id: string;
  name: string;
  logoUrl: string | null;
}

interface CreatorConversationSummary {
  id: string;
  brand: BrandFace | null;
  contactName: string | null;
  blocked: boolean;
  lastMessageAt: string;
  lastMessage: LastMessage | null;
  unread: number;
  openBookings: number;
}

export interface CreatorBooking {
  id: string;
  conversationId: string | null;
  proposedBy: 'vendor' | 'creator';
  packageId: string | null;
  package: { title: string; platform: string | null; priceAmount: number | null; priceIsFrom: boolean; currency: string } | null;
  contactName: string;
  company: string | null;
  website: string | null;
  brief: string;
  budgetNote: string | null;
  status: BookingStatus;
  creatorMessage: string | null;
  createdAt: string;
  tracked: boolean;
  /** Accepting makes you the brand's partner on one of its programs. */
  tracksOnAccept?: boolean;
  amount: number | null;
  currency: string | null;
  amountMinor: number | null;
  deliverableUrls: string[];
  deliveredAt: string | null;
  completedAt: string | null;
  paidAt: string | null;
  /** The brand paid by a method that takes days to settle (bank debits). */
  paymentProcessing?: boolean;
  refundedMinor: number;
  disputedAt: string | null;
}

interface CreatorThread {
  conversation: {
    id: string;
    brand: BrandFace | null;
    contactName: string | null;
    blocked: boolean;
    brandActive: boolean;
  };
  messages: ConversationMessage[];
  hasMore: boolean;
  bookings: CreatorBooking[];
}

const ERRORS: Record<string, string> = {
  payments_not_ready: 'Your Stripe account can’t take payments yet. Finish setting it up under Storefront → Packages.',
  amount_required: 'Name your price to accept this request.',
  amount_too_large: 'That amount is too large to charge in one payment.',
  already_answered: 'This request has already been answered.',
  not_claimed: 'This older request has no brand account behind it, so it can’t be booked here.',
  brand_unavailable: 'This brand isn’t on the Network any more.',
  conversation_blocked: 'You’ve blocked this brand. Unblock them to send an offer.',
  too_many_open_bookings: 'You already have 3 open bookings with this brand.',
  not_paid: 'The brand hasn’t paid yet. Deliver once the booking is paid.',
  not_withdrawable: 'This booking can’t be withdrawn now.',
  payment_processing: 'The brand’s payment is processing, so this can’t be withdrawn. Refund it once it’s through if you need to.',
  not_refundable: 'This booking can’t be refunded.',
  already_refunded: 'This booking has already been refunded in full.',
  stripe_error: 'Stripe couldn’t do that just now. Try again, or refund from your Stripe Dashboard.',
  rate_limited: 'You’re sending messages very quickly. Wait a little and try again.',
  creator_unavailable: 'Your account can’t do this right now.',
  partnership_ended: 'Your earlier partnership with this brand on that program ended, so this request can’t make you their partner again. Ask the brand to re-invite you.',
};

function errText(err: unknown): unknown {
  const code = creatorErrorCode(err);
  return code && ERRORS[code] ? ERRORS[code] : err;
}

function brandLabel(c: { brand: BrandFace | null; contactName: string | null }): string {
  const name = c.brand?.name ?? 'Brand';
  return c.contactName ? `${c.contactName} at ${name}` : name;
}

export function CreatorMessagesPage() {
  const list = useQuery({
    queryKey: ['creator-conversations'],
    queryFn: () => creatorApi<{ conversations: CreatorConversationSummary[]; unreadTotal: number }>('/creators/me/conversations'),
    refetchInterval: 30_000,
  });
  return (
    <Page title="Messages" subtitle="Brands you’re talking to. Bookings live in the conversation: accept at your price, or send an offer.">
      <ErrorBanner error={list.error} />
      {list.isLoading ? (
        <Card>Loading…</Card>
      ) : !list.data || list.data.conversations.length === 0 ? (
        <EmptyState
          title="No messages yet"
          hint="When a brand messages you or requests one of your packages, it shows up here."
          icon={<MessagesSquare size={28} strokeWidth={1.25} />}
        />
      ) : (
        <Card padded={false}>
          {list.data.conversations.map((c, i) => (
            <Link
              key={c.id}
              to={`/creator/messages/${c.id}`}
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
              <Face name={c.brand?.name ?? '?'} src={c.brand?.logoUrl} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 14, fontWeight: c.unread > 0 ? 600 : 500 }}>{brandLabel(c)}</span>
                  {c.blocked && <span style={{ fontSize: 11, color: theme.textDim }}>blocked</span>}
                  {c.openBookings > 0 && (
                    <span style={{ fontSize: 11, color: theme.textMuted, border: `1px solid ${theme.borderSubtle}`, borderRadius: 999, padding: '1px 7px' }}>
                      {c.openBookings} open {c.openBookings === 1 ? 'booking' : 'bookings'}
                    </span>
                  )}
                </div>
                <div style={{ fontSize: 13, color: theme.textMuted, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {previewLine(c.lastMessage, 'creator', { creator: 'You', brand: c.brand?.name ?? 'The brand' })}
                </div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
                <span style={{ fontSize: 12, color: theme.textDim }}>{timeLabel(c.lastMessageAt)}</span>
                <UnreadDot count={c.unread} />
              </div>
            </Link>
          ))}
        </Card>
      )}
    </Page>
  );
}

export function CreatorThreadPage() {
  const { id = '' } = useParams();
  const qc = useQueryClient();
  const payments = usePayments();
  const [older, setOlder] = useState<ConversationMessage[]>([]);
  const [olderHasMore, setOlderHasMore] = useState<boolean | null>(null);
  const [offering, setOffering] = useState(false);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['creator-thread', id] });
    void qc.invalidateQueries({ queryKey: ['creator-conversations'] });
  };
  // Live: the brand's presence and typing, and new messages at once.
  const live = useConversationLive(
    id,
    'creator',
    () => creatorApi<LiveTicket>(`/creators/me/conversations/${encodeURIComponent(id)}/realtime`, { method: 'POST', body: {} }),
    refresh,
  );
  const thread = useQuery({
    queryKey: ['creator-thread', id],
    queryFn: () => creatorApi<CreatorThread>(`/creators/me/conversations/${encodeURIComponent(id)}`),
    refetchInterval: live.connected ? 60_000 : 10_000,
  });
  const send = useMutation({
    mutationFn: (body: string) => creatorApi(`/creators/me/conversations/${encodeURIComponent(id)}/messages`, { method: 'POST', body: { body } }),
    onSuccess: refresh,
  });
  const block = useMutation({
    mutationFn: (blocked: boolean) => creatorApi(`/creators/me/conversations/${encodeURIComponent(id)}/${blocked ? 'block' : 'unblock'}`, { method: 'POST', body: {} }),
    onSuccess: refresh,
  });
  const earlier = useMutation({
    mutationFn: (before: string) => creatorApi<CreatorThread>(`/creators/me/conversations/${encodeURIComponent(id)}?before=${encodeURIComponent(before)}`),
    onSuccess: (page) => {
      setOlder((prev) => [...page.messages, ...prev]);
      setOlderHasMore(page.hasMore);
    },
  });

  if (thread.isLoading) return <Page title="Messages"><Card>Loading…</Card></Page>;
  if (!thread.data) return <Page title="Messages"><ErrorBanner error={thread.error ?? 'This conversation isn’t available.'} /></Page>;
  const t = thread.data;
  const brand = brandLabel(t.conversation);
  // Messages already carry who at the brand wrote them ("Grace · Notewise").
  const names = { creator: 'You', brand: t.conversation.brand?.name ?? 'The brand' };
  const messages = [...older, ...t.messages];
  const bookings = new Map(t.bookings.map((b) => [b.id, b]));
  const ready = payments.data?.ready ?? false;

  return (
    <Page
      title={t.conversation.brand?.name ?? 'Conversation'}
      subtitle={t.conversation.contactName ? `With ${t.conversation.contactName}` : undefined}
      actions={
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {!t.conversation.blocked && t.conversation.brandActive && (
            <Button onClick={() => setOffering(true)} disabled={!ready}>
              Send an offer
            </Button>
          )}
          <Button
            variant="ghost"
            disabled={block.isPending}
            onClick={() => {
              if (t.conversation.blocked || window.confirm(`Block ${t.conversation.brand?.name ?? 'this brand'}? They won’t be able to message or book you.`)) {
                block.mutate(!t.conversation.blocked);
              }
            }}
          >
            {t.conversation.blocked ? 'Unblock' : 'Block'}
          </Button>
        </div>
      }
    >
      <div style={{ marginBottom: 10, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <Link to="/creator/messages" style={{ fontSize: 13, color: theme.accentText }}>← All messages</Link>
        <PresenceBadge online={live.otherOnline} />
      </div>
      {payments.data && !ready && (
        <div style={{ fontSize: 13, color: theme.warn, background: theme.warnSoft, borderRadius: theme.radiusSm, padding: '10px 12px', marginBottom: 12 }}>
          Connect Stripe to accept bookings and send offers: brands pay you upfront into your own account.{' '}
          <Link to="/creator/storefront" style={{ color: theme.warn, fontWeight: 600 }}>Set up payments</Link>
        </div>
      )}
      <Card>
        <Thread
          messages={messages}
          side="creator"
          names={names}
          hasMore={olderHasMore ?? t.hasMore}
          loadingEarlier={earlier.isPending}
          onLoadEarlier={() => messages[0] && earlier.mutate(messages[0].id)}
          renderBooking={(bookingId) => {
            const b = bookings.get(bookingId);
            return b ? <CreatorBookingCard booking={b} brand={brand} brandName={names.brand} canAccept={ready} onChanged={refresh} /> : null;
          }}
        />
        <TypingNote name={live.typing} />
        <div style={{ marginTop: 8, borderTop: `1px solid ${theme.borderSubtle}`, paddingTop: 14 }}>
          <ErrorBanner error={send.error ? errText(send.error) : block.error} />
          <Composer
            onSend={(body) => send.mutateAsync(body)}
            pending={send.isPending}
            disabledReason={!t.conversation.brandActive ? 'This brand isn’t on the Network any more.' : null}
            placeholder={`Message ${t.conversation.brand?.name ?? 'the brand'}`}
            onTyping={live.setTyping}
          />
        </div>
      </Card>
      {offering && (
        <OfferDialog
          conversationId={t.conversation.id}
          brandName={t.conversation.brand?.name ?? 'the brand'}
          defaultCurrency={payments.data?.currency ?? 'USD'}
          onClose={() => {
            setOffering(false);
            refresh();
          }}
        />
      )}
    </Page>
  );
}

function CreatorBookingCard({
  booking: b,
  brand,
  brandName,
  canAccept,
  onChanged,
}: {
  booking: CreatorBooking;
  /** "Grace at Acme", for who you're talking to. */
  brand: string;
  /** "Acme", for what the brand itself does or gets. */
  brandName: string;
  canAccept: boolean;
  onChanged: () => void;
}) {
  const fixed = b.package && b.package.priceAmount != null && !b.package.priceIsFrom ? b.package.priceAmount : null;
  const [amount, setAmount] = useState(String(b.amount ?? fixed ?? ''));
  const [currency, setCurrency] = useState(b.currency ?? b.package?.currency ?? 'USD');
  const [note, setNote] = useState('');
  const [urls, setUrls] = useState('');
  const act = useMutation({
    mutationFn: (v: { action: 'accept' | 'decline' | 'withdraw' | 'deliver' | 'refund'; body?: unknown }) =>
      creatorApi(`/creators/me/bookings/${encodeURIComponent(b.id)}/${v.action}`, { method: 'POST', body: v.body ?? {} }),
    onSuccess: onChanged,
  });
  const amountOk = /^\d{1,8}$/.test(amount.trim()) && Number(amount) >= 1;
  const urlList = urls
    .split(/\s+/)
    .map((u) => u.trim())
    .filter(Boolean);
  const urlsOk = urlList.length >= 1 && urlList.length <= 5 && urlList.every((u) => /^https?:\/\/\S+$/i.test(u));
  const priceShown =
    b.amount != null && b.currency ? formatWholeAmount(b.amount, b.currency) : b.package?.priceAmount != null ? `From ${formatWholeAmount(b.package.priceAmount, b.package.currency)}` : 'Price to agree';
  const currencies = (PACKAGE_CURRENCIES as readonly string[]).includes(currency) ? PACKAGE_CURRENCIES : [currency, ...PACKAGE_CURRENCIES];

  return (
    <div style={{ border: `1px solid ${theme.border}`, borderRadius: theme.radiusSm, padding: 14, background: theme.surface }}>
      <ErrorBanner error={act.error ? errText(act.error) : null} />
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 200 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 15, fontWeight: 500 }}>{b.package?.title ?? 'Custom collaboration'}</span>
            <BookingStatusPill status={b.status} />
            {b.proposedBy === 'creator' && <span style={{ fontSize: 12, color: theme.textDim }}>your offer</span>}
            {b.tracked && <span style={{ fontSize: 12, color: theme.textDim }}>tracked: you&rsquo;re {brandName}&rsquo;s partner</span>}
          </div>
          <div style={{ fontSize: 12, color: theme.textMuted, marginTop: 3 }}>
            {b.contactName}
            {b.company ? ` · ${b.company}` : ''}
            {b.website && (
              <>
                {' · '}
                <a href={b.website} target="_blank" rel="noopener noreferrer nofollow" style={{ color: theme.accentText }}>
                  {b.website.replace(/^https?:\/\//, '')}
                </a>
              </>
            )}
          </div>
        </div>
        <div style={{ fontSize: 15, fontWeight: 600 }}>{priceShown}</div>
      </div>
      <div style={{ fontSize: 13, color: theme.textMuted, marginTop: 10, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{b.brief}</div>
      {b.budgetNote && <div style={{ fontSize: 13, color: theme.textMuted, marginTop: 6 }}>Budget: {b.budgetNote}</div>}

      {b.status === 'pending' && (
        <div style={{ marginTop: 12 }}>
          <div className="op-grid-collapse" style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 10 }}>
            <div>
              <Label>Your price</Label>
              <Input value={amount} inputMode="numeric" aria-label="Your price" onChange={(e) => setAmount(e.target.value)} placeholder="500" />
            </div>
            <div>
              <Label>Currency</Label>
              <Select value={currency} onChange={(e) => setCurrency(e.target.value)}>
                {currencies.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </Select>
            </div>
          </div>
          <div style={{ marginTop: 10 }}>
            <Label>Note (optional)</Label>
            <Textarea value={note} rows={2} maxLength={1000} onChange={(e) => setNote(e.target.value)} placeholder="Timing, what you’ll need from them…" />
          </div>
          <div style={{ fontSize: 12, color: theme.textDim, marginTop: 6 }}>
            {brand} pays this upfront, into your Stripe account, before you start. OpenPartner&rsquo;s fee is added on top for them.
            {b.tracksOnAccept && (
              <>
                {' '}
                This request is tracked: accepting makes you {brandName}&rsquo;s partner on one of its programs, with a tracked link, and
                gives {brandName} your name and email for its partner records.
              </>
            )}
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
            <Button
              disabled={!canAccept || !amountOk || act.isPending}
              onClick={() => act.mutate({ action: 'accept', body: { amount: Number(amount), currency, ...(note.trim() ? { message: note.trim() } : {}) } })}
            >
              {amountOk ? `Accept at ${formatWholeAmount(Number(amount), currency)}` : 'Accept'}
            </Button>
            <Button
              variant="secondary"
              disabled={act.isPending}
              onClick={() => {
                if (window.confirm('Decline this request? The brand is told.')) act.mutate({ action: 'decline', body: note.trim() ? { message: note.trim() } : {} });
              }}
            >
              Decline
            </Button>
          </div>
        </div>
      )}

      <div style={{ fontSize: 13, color: theme.textMuted, marginTop: 10 }}>
        {b.status === 'awaiting_payment' && b.paymentProcessing && (
          <>{brand} paid by bank, which can take a few days to clear. Wait for it to clear before starting the work.</>
        )}
        {b.status === 'awaiting_payment' && !b.paymentProcessing && (
          <>Waiting for {brand} to pay. You&rsquo;re paid {b.amountMinor != null && b.currency ? formatMinor(b.amountMinor, b.currency) : priceShown} into your Stripe account, less Stripe&rsquo;s fees.</>
        )}
        {b.status === 'paid' && <>Paid {formatDate(b.paidAt)}. Mark it delivered once it&rsquo;s live.</>}
        {b.status === 'delivered' && <>Delivered {formatDate(b.deliveredAt)}. {brand} reviews it; it completes by itself after 14 days.</>}
        {b.status === 'completed' && <>Completed {formatDate(b.completedAt)}.</>}
        {b.refundedMinor > 0 && b.currency && <> {formatMinor(b.refundedMinor, b.currency)} refunded.</>}
        {b.disputedAt && <> The brand disputed the payment with their card issuer; you&rsquo;ll find it in your Stripe Dashboard.</>}
      </div>

      {b.status === 'paid' && (
        <div style={{ marginTop: 10 }}>
          <Label>Links to the published work (one per line, up to 5)</Label>
          <Textarea value={urls} rows={2} onChange={(e) => setUrls(e.target.value)} placeholder="https://www.youtube.com/watch?v=…" />
        </div>
      )}
      <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
        {b.status === 'paid' && (
          <Button disabled={!urlsOk || act.isPending} onClick={() => act.mutate({ action: 'deliver', body: { urls: urlList } })}>
            Mark delivered
          </Button>
        )}
        {b.status === 'awaiting_payment' && !b.paymentProcessing && (
          <Button
            variant="secondary"
            disabled={act.isPending}
            onClick={() => {
              if (window.confirm('Withdraw this? Nothing has been charged.')) act.mutate({ action: 'withdraw' });
            }}
          >
            Withdraw
          </Button>
        )}
        {['paid', 'delivered', 'completed'].includes(b.status) && (
          <Button
            variant="ghost"
            disabled={act.isPending}
            onClick={() => {
              if (window.confirm(`Refund ${brand} in full? The money goes back to them from your Stripe account, and OpenPartner refunds its fee.`)) {
                act.mutate({ action: 'refund' });
              }
            }}
          >
            Refund
          </Button>
        )}
      </div>
    </div>
  );
}

function OfferDialog({
  conversationId,
  brandName,
  defaultCurrency,
  onClose,
}: {
  conversationId: string;
  brandName: string;
  defaultCurrency: string;
  onClose: () => void;
}) {
  const storefront = useQuery({
    queryKey: ['creator-storefront'],
    queryFn: () => creatorApi<{ packages: OwnPackage[] }>('/creators/me/storefront'),
  });
  const [packageId, setPackageId] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState(defaultCurrency);
  const offer = useMutation({
    mutationFn: () =>
      creatorApi(`/creators/me/conversations/${encodeURIComponent(conversationId)}/offers`, {
        method: 'POST',
        body: {
          ...(packageId ? { packageId } : { title: title.trim() }),
          description: description.trim(),
          amount: Number(amount),
          currency,
        },
      }),
    onSuccess: onClose,
  });
  const packages = storefront.data?.packages ?? [];
  const amountOk = /^\d{1,8}$/.test(amount.trim()) && Number(amount) >= 1;
  const ok = amountOk && description.trim().length > 0 && (packageId || title.trim().length > 0);
  const currencies = (PACKAGE_CURRENCIES as readonly string[]).includes(currency) ? PACKAGE_CURRENCIES : [currency, ...PACKAGE_CURRENCIES];

  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{ position: 'fixed', inset: 0, background: theme.overlay, display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50 }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div style={{ background: theme.surface, border: `1px solid ${theme.borderSubtle}`, borderRadius: theme.radiusSm, padding: 24, maxWidth: 520, width: '92%', maxHeight: '90vh', overflow: 'auto' }}>
        <div style={{ fontSize: 15, fontWeight: 500, marginBottom: 4 }}>Send {brandName} an offer</div>
        <p style={{ fontSize: 13, color: theme.textMuted, margin: '0 0 14px', lineHeight: 1.5 }}>
          Name the work and your price. {brandName} accepts by paying, upfront, into your Stripe account; OpenPartner&rsquo;s fee is added on top for them.
        </p>
        <ErrorBanner error={offer.error ? errText(offer.error) : null} />
        <div style={{ marginBottom: 12 }}>
          <Label>Package</Label>
          <Select
            value={packageId}
            onChange={(e) => {
              setPackageId(e.target.value);
              const p = packages.find((x) => x.id === e.target.value);
              if (p) {
                setCurrency(p.currency);
                if (p.priceAmount != null) setAmount(String(p.priceAmount));
              }
            }}
          >
            <option value="">Something custom</option>
            {packages.map((p) => (
              <option key={p.id} value={p.id}>{p.title}</option>
            ))}
          </Select>
        </div>
        {!packageId && (
          <div style={{ marginBottom: 12 }}>
            <Label>What it is</Label>
            <Input value={title} maxLength={80} onChange={(e) => setTitle(e.target.value)} placeholder="Dedicated video + 2 stories" />
          </div>
        )}
        <div style={{ marginBottom: 12 }}>
          <Label>Details</Label>
          <Textarea value={description} rows={4} maxLength={2000} onChange={(e) => setDescription(e.target.value)} placeholder="What’s included, timing, usage rights…" />
        </div>
        <div className="op-grid-collapse" style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 10, marginBottom: 16 }}>
          <div>
            <Label>Price</Label>
            <Input value={amount} inputMode="numeric" aria-label="Price" onChange={(e) => setAmount(e.target.value)} placeholder="1200" />
          </div>
          <div>
            <Label>Currency</Label>
            <Select value={currency} onChange={(e) => setCurrency(e.target.value)}>
              {currencies.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </Select>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <Button disabled={!ok || offer.isPending} onClick={() => offer.mutate()}>
            {offer.isPending ? 'Sending…' : amountOk ? `Send offer for ${formatWholeAmount(Number(amount), currency)}` : 'Send offer'}
          </Button>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
        </div>
      </div>
    </div>
  );
}

/** Unread messages across the creator's conversations, for the sidebar. */
export function useCreatorUnreadMessages(): number {
  const q = useQuery({
    queryKey: ['creator-conversations'],
    queryFn: () => creatorApi<{ conversations: CreatorConversationSummary[]; unreadTotal: number }>('/creators/me/conversations'),
    refetchInterval: 60_000,
    retry: false,
  });
  return q.data?.unreadTotal ?? 0;
}
