/**
 * Conversations between a creator and a brand (the Network's
 * docs/creator-storefront.md §8.1), shared by the creator's Messages
 * (CreatorMessages.tsx) and the brand's Network → Messages
 * (admin/NetworkMessages.tsx).
 *
 * A thread is text messages plus booking events. Each booking's card is
 * drawn where it started (its "requested" or "offered" event) and shows its
 * current state; later events are one-line notes. Everything the other side
 * typed is rendered as text, never HTML.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button, Textarea } from '../../ui.js';
import { alpha, theme } from '../../theme.js';

export type ConversationAuthor = 'creator' | 'vendor' | 'system';
export type BookingEvent =
  | 'requested'
  | 'offered'
  | 'accepted'
  | 'declined'
  | 'withdrawn'
  | 'paid'
  | 'payment_failed'
  | 'delivered'
  | 'completed'
  | 'cancelled'
  | 'refunded'
  | 'disputed'
  | 'expired'
  | 'tracked';

export interface ConversationMessage {
  id: string;
  author: ConversationAuthor;
  authorName: string | null;
  kind: 'text' | 'event';
  body: string | null;
  event: BookingEvent | null;
  bookingId: string | null;
  createdAt: string;
}

export type BookingStatus =
  | 'pending'
  | 'awaiting_payment'
  | 'paid'
  | 'delivered'
  | 'completed'
  | 'declined'
  | 'cancelled'
  | 'refunded'
  | 'accepted'
  | 'approved'
  | 'payout_failed';

export interface LastMessage {
  author: ConversationAuthor;
  kind: 'text' | 'event';
  event: BookingEvent | null;
  preview: string | null;
  createdAt: string;
}

/** Messages are capped at this on the Network. */
export const MESSAGE_MAX = 4000;

// ----- amounts -----

const ZERO_DECIMAL = new Set(['BIF', 'CLP', 'DJF', 'GNF', 'JPY', 'KMF', 'KRW', 'MGA', 'PYG', 'RWF', 'VND', 'VUV', 'XAF', 'XOF', 'XPF']);
const THREE_DECIMAL = new Set(['BHD', 'JOD', 'KWD', 'OMR', 'TND']);

/** Stripe's integer amount as money: "$1,260", "$12.50", "¥15,000". */
export function formatMinor(minor: number, currency: string): string {
  const code = currency.toUpperCase();
  const exp = ZERO_DECIMAL.has(code) ? 0 : THREE_DECIMAL.has(code) ? 3 : 2;
  const major = minor / 10 ** exp;
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: code,
      minimumFractionDigits: Number.isInteger(major) ? 0 : exp,
      maximumFractionDigits: exp,
    }).format(major);
  } catch {
    return `${major.toLocaleString('en-US')} ${code}`;
  }
}

/** Whole-unit prices, as storefront packages show them: "$1,200". */
export function formatWholeAmount(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 0, minimumFractionDigits: 0 }).format(amount);
  } catch {
    return `${amount.toLocaleString('en-US')} ${currency}`;
  }
}

// ----- labels -----

export function timeLabel(iso: string): string {
  const d = new Date(iso);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/** The one-line note for a booking event, from `side`'s point of view. */
export function eventText(
  m: ConversationMessage,
  side: 'creator' | 'vendor',
  names: { creator: string; brand: string },
): string {
  const by = m.author === 'creator' ? (side === 'creator' ? 'You' : names.creator) : m.author === 'vendor' ? (side === 'vendor' ? 'You' : names.brand) : null;
  switch (m.event) {
    case 'requested':
      return `${by ?? names.brand} requested a booking`;
    case 'offered':
      return `${by ?? names.creator} sent an offer`;
    case 'accepted':
      return `${by ?? names.creator} accepted the request`;
    case 'declined':
      return `${by ?? 'Someone'} declined`;
    case 'withdrawn':
      return `${by ?? names.creator} withdrew the offer`;
    case 'paid':
      return `${by ?? names.brand} paid. The booking is confirmed`;
    case 'delivered':
      return `${by ?? names.creator} delivered the work`;
    case 'completed':
      return m.author === 'system' ? 'Completed automatically, 14 days after delivery' : `${by ?? names.brand} approved the work`;
    case 'cancelled':
      return `${by ?? names.brand} cancelled the request`;
    case 'refunded':
      return `${by ?? names.creator} refunded the booking${m.body ? ` (${m.body.replace(/^Refunded /, '')})` : ''}`;
    case 'payment_failed':
      return 'The payment didn’t go through. The booking is waiting for payment again';
    case 'tracked':
      return side === 'creator'
        ? `${names.brand} tracks this booking${m.body ? ` on ${m.body}` : ''}: you’re its partner there, and it has your name and email as its partner`
        : `You track this booking${m.body ? ` on ${m.body}` : ''}. ${names.creator} is now your partner there`;
    case 'disputed':
      return 'The payment was disputed with the card issuer';
    case 'expired':
      return 'Cancelled: not paid within 30 days';
    default:
      return 'Booking updated';
  }
}

const PILL: Record<BookingStatus, { text: string; tone: 'muted' | 'warn' | 'info' | 'success' | 'danger' }> = {
  pending: { text: 'Request', tone: 'muted' },
  awaiting_payment: { text: 'Awaiting payment', tone: 'warn' },
  paid: { text: 'Paid', tone: 'success' },
  delivered: { text: 'Delivered', tone: 'info' },
  completed: { text: 'Completed', tone: 'success' },
  declined: { text: 'Declined', tone: 'muted' },
  cancelled: { text: 'Cancelled', tone: 'muted' },
  refunded: { text: 'Refunded', tone: 'danger' },
  accepted: { text: 'Accepted', tone: 'muted' },
  approved: { text: 'Approved', tone: 'info' },
  payout_failed: { text: 'Payment failed', tone: 'danger' },
};

export function BookingStatusPill({ status }: { status: BookingStatus }) {
  const p = PILL[status] ?? { text: status, tone: 'muted' as const };
  const colors = {
    muted: { bg: theme.surface2, fg: theme.textMuted },
    warn: { bg: theme.warnSoft, fg: theme.warn },
    info: { bg: theme.infoSoft, fg: theme.info },
    success: { bg: theme.successSoft, fg: theme.success },
    danger: { bg: theme.dangerSoft, fg: theme.danger },
  }[p.tone];
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', background: colors.bg, color: colors.fg, borderRadius: 999, padding: '2px 9px', fontSize: 12, fontWeight: 500, whiteSpace: 'nowrap' }}>
      {p.text}
    </span>
  );
}

// ----- the thread -----

export function Thread({
  messages,
  side,
  names,
  renderBooking,
  hasMore,
  onLoadEarlier,
  loadingEarlier,
}: {
  messages: ConversationMessage[];
  side: 'creator' | 'vendor';
  names: { creator: string; brand: string };
  /** The booking's card, drawn at its first event. */
  renderBooking: (bookingId: string) => ReactNode;
  hasMore?: boolean;
  onLoadEarlier?: () => void;
  loadingEarlier?: boolean;
}) {
  const end = useRef<HTMLDivElement | null>(null);
  const lastId = messages.at(-1)?.id;
  useEffect(() => {
    end.current?.scrollIntoView?.({ block: 'end' });
  }, [lastId]);

  const drawn = new Set<string>();
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {hasMore && onLoadEarlier && (
        <div style={{ textAlign: 'center' }}>
          <Button size="sm" variant="ghost" onClick={onLoadEarlier} disabled={loadingEarlier}>
            {loadingEarlier ? 'Loading…' : 'Earlier messages'}
          </Button>
        </div>
      )}
      {messages.map((m) => {
        if (m.kind === 'event' && m.bookingId && (m.event === 'requested' || m.event === 'offered') && !drawn.has(m.bookingId)) {
          drawn.add(m.bookingId);
          return (
            <div key={m.id}>
              <EventNote text={eventText(m, side, names)} at={m.createdAt} />
              <div style={{ marginTop: 8 }}>{renderBooking(m.bookingId)}</div>
            </div>
          );
        }
        if (m.kind === 'event') return <EventNote key={m.id} text={eventText(m, side, names)} at={m.createdAt} />;
        const mine = m.author === side;
        const who = m.author === 'creator' ? names.creator : m.authorName ? `${m.authorName} · ${names.brand}` : names.brand;
        return (
          <div key={m.id} style={{ display: 'flex', justifyContent: mine ? 'flex-end' : 'flex-start' }}>
            <div style={{ maxWidth: 'min(560px, 85%)' }}>
              <div style={{ fontSize: 11, color: theme.textDim, marginBottom: 3, textAlign: mine ? 'right' : 'left' }}>
                {mine ? 'You' : who} · {timeLabel(m.createdAt)}
              </div>
              <div
                style={{
                  background: mine ? alpha(theme.accent, 0.12) : theme.surface2,
                  border: `1px solid ${mine ? alpha(theme.accent, 0.3) : theme.borderSubtle}`,
                  borderRadius: 10,
                  padding: '9px 12px',
                  fontSize: 14,
                  lineHeight: 1.5,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                }}
              >
                {m.body}
              </div>
            </div>
          </div>
        );
      })}
      <div ref={end} />
    </div>
  );
}

function EventNote({ text, at }: { text: string; at: string }) {
  return (
    <div style={{ textAlign: 'center', fontSize: 12, color: theme.textDim }}>
      {text} · {timeLabel(at)}
    </div>
  );
}

export function Composer({
  onSend,
  pending,
  disabledReason,
  placeholder = 'Write a message',
}: {
  onSend: (body: string) => Promise<unknown>;
  pending: boolean;
  /** Shown instead of the box when this side can't write. */
  disabledReason?: string | null;
  placeholder?: string;
}) {
  const [body, setBody] = useState('');
  if (disabledReason) {
    return <div style={{ fontSize: 13, color: theme.textMuted, background: theme.surface2, borderRadius: theme.radiusSm, padding: '10px 12px' }}>{disabledReason}</div>;
  }
  const text = body.trim();
  async function send() {
    if (!text || pending) return;
    await onSend(text);
    setBody('');
  }
  return (
    <div>
      <Textarea
        value={body}
        rows={3}
        maxLength={MESSAGE_MAX}
        placeholder={placeholder}
        aria-label="Message"
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void send();
          }
        }}
      />
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8 }}>
        <Button onClick={() => void send()} disabled={!text || pending}>
          {pending ? 'Sending…' : 'Send'}
        </Button>
        <span style={{ fontSize: 12, color: theme.textDim }}>Keep payments on OpenPartner: only bookings paid here are covered.</span>
      </div>
    </div>
  );
}

/** A small round picture or initial. */
export function Face({ name, src, size = 36 }: { name: string; src: string | null | undefined; size?: number }) {
  return src ? (
    <img src={src} alt="" style={{ width: size, height: size, borderRadius: '50%', objectFit: 'cover', background: theme.surface2, flexShrink: 0 }} />
  ) : (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        background: theme.accent,
        color: theme.accentInk,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontWeight: 600,
        flexShrink: 0,
      }}
    >
      {(name || '?').charAt(0).toUpperCase()}
    </div>
  );
}

/** "Ada: Sounds great" — the conversation list's preview line. */
export function previewLine(last: LastMessage | null, side: 'creator' | 'vendor', names: { creator: string; brand: string }): string {
  if (!last) return '';
  if (last.kind === 'event') {
    return eventText(
      { id: '', author: last.author, authorName: null, kind: 'event', body: last.preview, event: last.event, bookingId: null, createdAt: last.createdAt },
      side,
      names,
    );
  }
  const who = last.author === side ? 'You: ' : '';
  return `${who}${last.preview ?? ''}`;
}

export function UnreadDot({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span
      style={{
        minWidth: 18,
        height: 18,
        padding: '0 5px',
        borderRadius: 9,
        background: theme.accent,
        color: theme.accentInk,
        fontSize: 11,
        fontWeight: 700,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {count > 99 ? '99+' : count}
    </span>
  );
}
