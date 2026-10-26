/**
 * Conversations between a creator and a brand (the Network's
 * docs/creator-storefront.md §8.1), shared by the creator's Messages
 * (CreatorMessages.tsx) and the brand's Network → Messages
 * (admin/NetworkMessages.tsx).
 *
 * A thread is text messages, with their images, plus booking events. Each
 * booking's card is drawn where it started (its "requested" or "offered"
 * event) and shows its current state; later events are one-line notes.
 * Everything the other side typed is rendered as text, never HTML; only its
 * http(s) links become links (conversation-media.tsx).
 */
import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type ReactNode } from 'react';
import { ImagePlus, LoaderCircle, X } from 'lucide-react';
import { Button, Textarea } from '../../ui.js';
import { alpha, theme } from '../../theme.js';
import {
  AttachmentGrid,
  IMAGE_TYPES,
  ImageProblem,
  Linkified,
  MAX_IMAGES_PER_MESSAGE,
  prepareImage,
  seedAttachment,
  uploadErrorText,
  type LoadAttachment,
  type MessageAttachment,
} from './conversation-media.js';

export type { LoadAttachment, MessageAttachment } from './conversation-media.js';

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
  /** Images, in order. Older Networks don't send it. */
  attachments?: MessageAttachment[];
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
  /** Images in the message. */
  images?: number;
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
  loadAttachment,
}: {
  messages: ConversationMessage[];
  side: 'creator' | 'vendor';
  names: { creator: string; brand: string };
  /** The booking's card, drawn at its first event. */
  renderBooking: (bookingId: string) => ReactNode;
  hasMore?: boolean;
  onLoadEarlier?: () => void;
  loadingEarlier?: boolean;
  /** Fetches an image's file with this side's credentials. Keep it stable
   *  (useCallback): images reload when it changes. */
  loadAttachment: LoadAttachment;
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
        const images = m.attachments ?? [];
        return (
          <div key={m.id} style={{ display: 'flex', justifyContent: mine ? 'flex-end' : 'flex-start' }}>
            <div style={{ maxWidth: 'min(560px, 85%)', display: 'flex', flexDirection: 'column', gap: 6, alignItems: mine ? 'flex-end' : 'flex-start' }}>
              <div style={{ fontSize: 11, color: theme.textDim, textAlign: mine ? 'right' : 'left' }}>
                {mine ? 'You' : who} · {timeLabel(m.createdAt)}
              </div>
              {images.length > 0 && <AttachmentGrid attachments={images} load={loadAttachment} align={mine ? 'right' : 'left'} />}
              {m.body && (
                <div
                  style={{
                    background: mine ? alpha(theme.accent, 0.12) : theme.surface2,
                    border: `1px solid ${mine ? alpha(theme.accent, 0.3) : theme.borderSubtle}`,
                    borderRadius: 10,
                    padding: '9px 12px',
                    fontSize: 14,
                    lineHeight: 1.5,
                    whiteSpace: 'pre-wrap',
                    overflowWrap: 'anywhere',
                  }}
                >
                  <Linkified text={m.body} />
                </div>
              )}
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

/** An image in the composer: being prepared and uploaded, ready to send
 *  (`id`), or refused (`error`). */
interface PendingImage {
  key: string;
  preview: string | null;
  id?: string;
  error?: string;
}

let pendingKey = 0;

/** Touch keyboards keep Enter for a new line; the Send button sends. */
function coarsePointer(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
}

function imageFiles(list: FileList | null | undefined): File[] {
  return Array.from(list ?? []).filter((f) => f.type.startsWith('image/'));
}

/**
 * The message box. Enter sends and Shift+Enter starts a new line (on a touch
 * keyboard Enter is a new line). With `onUpload`, images can be pasted,
 * dropped or picked: each is prepared (conversation-media.tsx) and uploaded
 * straight away, and sent with the message, up to four.
 */
export function Composer({
  onSend,
  pending,
  disabledReason,
  placeholder = 'Write a message',
  onTyping,
  onUpload,
}: {
  onSend: (message: { body: string; attachmentIds: string[] }) => Promise<unknown>;
  pending: boolean;
  /** Shown instead of the box when this side can't write. */
  disabledReason?: string | null;
  placeholder?: string;
  /** Told as this side types and stops (the live socket, conversation-live.ts). */
  onTyping?: (typing: boolean) => void;
  /** Uploads an image to the conversation; without it, the box is text only. */
  onUpload?: (image: Blob) => Promise<MessageAttachment>;
}) {
  const [body, setBody] = useState('');
  const [images, setImages] = useState<PendingImage[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const picker = useRef<HTMLInputElement | null>(null);
  const touch = useMemo(coarsePointer, []);
  const latest = useRef(images);
  latest.current = images;
  // Previews are blob URLs: let them go with the composer.
  useEffect(() => () => latest.current.forEach((i) => i.preview && URL.revokeObjectURL(i.preview)), []);

  if (disabledReason) {
    return <div style={{ fontSize: 13, color: theme.textMuted, background: theme.surface2, borderRadius: theme.radiusSm, padding: '10px 12px' }}>{disabledReason}</div>;
  }

  const text = body.trim();
  const uploading = images.some((i) => !i.id && !i.error);
  const ready = images.filter((i) => i.id).map((i) => i.id!);
  const canSend = (text.length > 0 || ready.length > 0) && !uploading && !pending;

  function update(key: string, patch: Partial<PendingImage>) {
    setImages((list) => list.map((i) => (i.key === key ? { ...i, ...patch } : i)));
  }

  function remove(key: string) {
    setImages((list) => {
      const gone = list.find((i) => i.key === key);
      if (gone?.preview) URL.revokeObjectURL(gone.preview);
      return list.filter((i) => i.key !== key);
    });
  }

  function add(files: File[]) {
    if (!onUpload || files.length === 0) return;
    setProblem(null);
    const room = MAX_IMAGES_PER_MESSAGE - latest.current.filter((i) => !i.error).length;
    if (room <= 0) {
      setProblem(`Up to ${MAX_IMAGES_PER_MESSAGE} images per message.`);
      return;
    }
    if (files.length > room) setProblem(`Up to ${MAX_IMAGES_PER_MESSAGE} images per message: the first ${room} were added.`);
    for (const file of files.slice(0, room)) {
      const key = `img${++pendingKey}`;
      const preview = typeof URL.createObjectURL === 'function' ? URL.createObjectURL(file) : null;
      setImages((list) => [...list, { key, preview }]);
      void (async () => {
        try {
          const blob = await prepareImage(file);
          const attachment = await onUpload(blob);
          seedAttachment(attachment.id, blob);
          update(key, { id: attachment.id });
        } catch (err) {
          update(key, { error: err instanceof ImageProblem ? err.message : uploadErrorText(err) });
        }
      })();
    }
  }

  async function send() {
    if (!canSend) return;
    onTyping?.(false);
    const sentText = text;
    const sent = new Set(images.filter((i) => i.id).map((i) => i.key));
    await onSend({ body: sentText, attachmentIds: ready });
    // Clear only what went: text typed or images added while it was sending
    // stay. Refused images go too; they were never going to be sent.
    setBody((current) => (current.trim() === sentText ? '' : current));
    setProblem(null);
    setImages((list) =>
      list.filter((i) => {
        if (!sent.has(i.key) && !i.error) return true;
        if (i.preview) URL.revokeObjectURL(i.preview);
        return false;
      }),
    );
  }

  function onPaste(e: ClipboardEvent<HTMLTextAreaElement>) {
    const files = imageFiles(e.clipboardData?.files);
    if (files.length === 0 || !onUpload) return;
    // A copied image may come with its name or markup as text: keep only
    // the image, unless there's real text alongside it.
    if (!e.clipboardData.getData('text/plain').trim()) e.preventDefault();
    add(files);
  }

  function onDrop(e: DragEvent<HTMLDivElement>) {
    setDragging(false);
    const files = imageFiles(e.dataTransfer?.files);
    if (files.length === 0 || !onUpload) return;
    e.preventDefault();
    add(files);
  }

  const lines = body.split('\n').length;
  return (
    <div
      onDragOver={(e) => {
        if (!onUpload || !Array.from(e.dataTransfer?.types ?? []).includes('Files')) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
      style={{ borderRadius: theme.radiusSm, outline: dragging ? `2px dashed ${theme.accent}` : 'none', outlineOffset: 4 }}
    >
      {images.length > 0 && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
          {images.map((i) => (
            <div
              key={i.key}
              title={i.error}
              style={{
                position: 'relative',
                width: 72,
                height: 72,
                borderRadius: 8,
                overflow: 'hidden',
                background: theme.surface2,
                border: `1px solid ${i.error ? theme.danger : theme.borderSubtle}`,
              }}
            >
              {i.preview && <img src={i.preview} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', opacity: i.id ? 1 : 0.5 }} />}
              {!i.id && !i.error && (
                <span aria-label="Uploading" style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: theme.text }}>
                  <LoaderCircle size={20} className="op-spin" />
                </span>
              )}
              <button
                type="button"
                aria-label="Remove image"
                onClick={() => remove(i.key)}
                style={{
                  position: 'absolute',
                  top: 3,
                  right: 3,
                  width: 20,
                  height: 20,
                  borderRadius: '50%',
                  border: 'none',
                  padding: 0,
                  background: alpha('#000000', 0.6),
                  color: '#fff',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  cursor: 'pointer',
                }}
              >
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
      )}
      {(problem || images.some((i) => i.error)) && (
        <div role="alert" style={{ fontSize: 12, color: theme.danger, marginBottom: 6 }}>
          {problem ?? images.find((i) => i.error)?.error}
        </div>
      )}
      <Textarea
        value={body}
        rows={Math.min(8, Math.max(2, lines))}
        maxLength={MESSAGE_MAX}
        placeholder={placeholder}
        aria-label="Message"
        onChange={(e) => {
          setBody(e.target.value);
          onTyping?.(e.target.value.trim().length > 0);
        }}
        onBlur={() => onTyping?.(false)}
        onPaste={onPaste}
        onKeyDown={(e) => {
          if (e.key !== 'Enter' || e.shiftKey || e.altKey) return;
          // Mid-composition (Japanese, Chinese, …) Enter picks the word.
          if (e.nativeEvent.isComposing || e.keyCode === 229) return;
          if (touch && !e.metaKey && !e.ctrlKey) return;
          e.preventDefault();
          void send();
        }}
      />
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8, flexWrap: 'wrap' }}>
        <Button onClick={() => void send()} disabled={!canSend}>
          {pending ? 'Sending…' : uploading ? 'Uploading…' : 'Send'}
        </Button>
        {onUpload && (
          <>
            <Button variant="ghost" size="sm" onClick={() => picker.current?.click()} icon={<ImagePlus size={16} />}>
              Image
            </Button>
            <input
              ref={picker}
              type="file"
              accept={IMAGE_TYPES.join(',')}
              multiple
              hidden
              aria-label="Add images"
              onChange={(e) => {
                add(imageFiles(e.target.files));
                e.target.value = '';
              }}
            />
          </>
        )}
        <span style={{ fontSize: 12, color: theme.textDim }}>
          {touch ? '' : 'Enter to send, Shift+Enter for a new line. '}Keep payments on OpenPartner: only bookings paid here are covered.
        </span>
      </div>
    </div>
  );
}

/** "● Online" while the other side has the thread open; nothing until the
 *  live socket knows. */
export function PresenceBadge({ online }: { online: boolean | null }) {
  if (online == null) return null;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, color: online ? theme.success : theme.textDim }}>
      <span
        aria-hidden
        style={{ width: 7, height: 7, borderRadius: '50%', background: online ? theme.success : theme.borderSubtle, display: 'inline-block' }}
      />
      {online ? 'Online' : 'Offline'}
    </span>
  );
}

/** "Grace at Acme is typing…" under the thread. Keeps its line so the
 *  composer doesn't jump. */
export function TypingNote({ name }: { name: string | null }) {
  return (
    <div aria-live="polite" style={{ minHeight: 18, fontSize: 12, color: theme.textMuted, fontStyle: 'italic', marginTop: 8 }}>
      {name != null ? `${name || 'They'} ${name ? 'is' : 'are'} typing…` : ''}
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
  const images = last.images ?? 0;
  return `${who}${last.preview ?? (images > 1 ? `${images} images` : images === 1 ? 'Image' : '')}`;
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
