/**
 * Request a booking from a creator's storefront: pick one of their packages
 * (or a custom collaboration), say what you'd like and, if you know it, what
 * you'll pay. It goes into your conversation with them (Network → Messages):
 * they accept at a price or decline, you pay upfront through Stripe
 * Checkout on their own Stripe account (the price plus OpenPartner's
 * booking fee), they deliver, you approve.
 *
 * Optionally track it on one of your offerings: the creator then becomes
 * your partner there, with a link you can measure. That adds a partner, so
 * it needs an active plan.
 */
import { useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api, ApiError } from '../../api.js';
import { Button, ErrorBanner, Input, Label, Select, Textarea } from '../../ui.js';
import { alpha, theme } from '../../theme.js';
import { TenantLink } from '../../tenant-link.js';
import { creatorApi } from '../creator/creator-api.js';
import { formatPackagePrice, PACKAGE_CURRENCIES, type StorefrontPackage } from '../creator/storefront-shared.js';

interface OfferingOption {
  id: string;
  title: string;
  published: boolean;
}

interface PublicStorefront {
  bookingsOpen?: boolean;
  packages?: StorefrontPackage[];
}

/** The Network's error code from a proxied call ("network_call_failed" with
 *  the Network's JSON body as the detail). */
export function networkErrorCode(err: unknown): string | null {
  if (!(err instanceof ApiError)) return null;
  const d = err.detail as { error?: string; detail?: unknown } | null;
  if (d && typeof d.detail === 'string') {
    try {
      const inner = JSON.parse(d.detail) as { error?: unknown };
      if (typeof inner.error === 'string') return inner.error;
    } catch {
      /* not JSON */
    }
  }
  return typeof d?.error === 'string' ? d.error : null;
}

const ERROR_TEXT: Record<string, string> = {
  bookings_closed: 'This creator isn’t taking bookings right now.',
  creator_not_found: 'This creator is no longer available.',
  too_many_open_bookings: 'You already have the maximum of 3 open bookings with this creator.',
  offering_not_found: 'That offering isn’t published any more.',
  package_not_found: 'That package isn’t available any more.',
  conversation_blocked: 'This creator isn’t taking requests from your brand.',
  amount_too_large: 'That amount is too large to charge in one payment.',
  brand_pending_review: 'Your brand is still being reviewed. You can book creators once it’s approved.',
  vendor_pending_review: 'Your brand is still being reviewed. You can book creators once it’s approved.',
  plan_required: 'Tracking a booking adds the creator as your partner, which needs an active plan. Leave the offering empty to book without tracking.',
  rate_limited: 'You’ve started a lot of conversations today. Try again tomorrow.',
};

export function BookCreatorDialog({
  creator,
  initialPackageId = null,
  onClose,
}: {
  creator: { id: string; name: string; handle: string };
  /** Opened from a package's Book button: start on that package. */
  initialPackageId?: string | null;
  onClose: () => void;
}) {
  const storefront = useQuery({
    queryKey: ['creator-public', creator.handle],
    queryFn: () => creatorApi<PublicStorefront>(`/creators/by-handle/${encodeURIComponent(creator.handle)}`),
    retry: false,
  });
  const offerings = useQuery({
    queryKey: ['admin-network-offerings'],
    queryFn: () => api<{ offerings: OfferingOption[] }>('/admin/network/offerings'),
    retry: false,
  });
  const published = useMemo(() => (offerings.data?.offerings ?? []).filter((o) => o.published), [offerings.data]);
  const packages = useMemo(() => storefront.data?.packages ?? [], [storefront.data]);
  const open = storefront.data?.bookingsOpen === true;

  const [packageId, setPackageId] = useState<string | null>(null);
  const [offeringId, setOfferingId] = useState('');
  const [amount, setAmount] = useState<string | null>(null);
  const [currency, setCurrency] = useState<string | null>(null);
  const [brief, setBrief] = useState('');

  // The starting package (from its Book button), once packages load.
  const pickedId = packageId ?? (initialPackageId && packages.some((p) => p.id === initialPackageId) ? initialPackageId : '');
  const picked = packages.find((p) => p.id === pickedId) ?? null;
  const fixedPrice = picked && picked.priceAmount != null && !picked.priceIsFrom ? picked.priceAmount : null;
  const amountText = amount ?? (fixedPrice != null ? String(fixedPrice) : '');
  const cur = currency ?? picked?.currency ?? 'USD';

  const book = useMutation({
    mutationFn: () =>
      api<{ booking: { id: string }; conversationId: string }>('/admin/network/bookings', {
        method: 'POST',
        body: {
          creatorId: creator.id,
          packageId: pickedId || null,
          ...(offeringId ? { offeringId } : {}),
          ...(amountText.trim() ? { amount: Number(amountText), currency: cur } : {}),
          brief: brief.trim(),
        },
      }),
  });

  const code = networkErrorCode(book.error) ?? (book.error instanceof ApiError ? book.error.message : null);
  const amountOk = amountText.trim() === '' || (/^\d{1,8}$/.test(amountText.trim()) && Number(amountText) >= 1);
  const canBook = amountOk && brief.trim().length >= 20 && !book.isPending;
  const currencies = (PACKAGE_CURRENCIES as readonly string[]).includes(cur) ? PACKAGE_CURRENCIES : [cur, ...PACKAGE_CURRENCIES];

  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{ position: 'fixed', inset: 0, background: theme.overlay, display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50 }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        style={{
          background: theme.surface,
          border: `1px solid ${theme.borderSubtle}`,
          borderRadius: theme.radiusSm,
          padding: 24,
          maxWidth: 520,
          width: '92%',
          maxHeight: '90vh',
          overflow: 'auto',
        }}
      >
        <div style={{ fontSize: 15, fontWeight: 500, marginBottom: 4 }}>Request a booking from @{creator.handle}</div>
        <p style={{ fontSize: 13, color: theme.textMuted, margin: '0 0 16px', lineHeight: 1.5 }}>
          {creator.name} accepts at a price or declines, in your conversation. You pay once they&rsquo;ve accepted, through
          Stripe, straight to their own Stripe account, with OpenPartner&rsquo;s booking fee added on top.
        </p>

        {book.isSuccess ? (
          <>
            <div
              style={{
                background: theme.successSoft,
                border: `1px solid ${alpha(theme.success, 0.333)}`,
                borderRadius: theme.radiusSm,
                padding: 12,
                fontSize: 13,
                color: theme.success,
                marginBottom: 14,
              }}
            >
              Request sent. {creator.name} has it in their messages.
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <TenantLink to={`/admin/network/messages/${book.data.conversationId}`} style={{ textDecoration: 'none' }}>
                <Button>Open the conversation</Button>
              </TenantLink>
              <Button onClick={onClose} variant="secondary">Close</Button>
            </div>
          </>
        ) : storefront.isLoading || offerings.isLoading ? (
          <p style={{ fontSize: 13, color: theme.textMuted }}>Loading…</p>
        ) : !open ? (
          <>
            <p style={{ fontSize: 13, color: theme.textMuted }}>{creator.name} isn&rsquo;t taking bookings right now. You can still invite them to apply.</p>
            <Button onClick={onClose} variant="secondary">Close</Button>
          </>
        ) : (
          <>
            {book.error && <ErrorBanner error={code && ERROR_TEXT[code] ? ERROR_TEXT[code] : book.error} />}
            <div style={{ marginBottom: 14 }}>
              <Label>Package</Label>
              <Select
                value={pickedId}
                onChange={(e) => {
                  setPackageId(e.target.value);
                  setAmount(null);
                  setCurrency(null);
                }}
              >
                <option value="">Custom collaboration</option>
                {packages.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.title} — {formatPackagePrice(p)}
                  </option>
                ))}
              </Select>
            </div>
            <div className="op-grid-collapse" style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 12, marginBottom: 6 }}>
              <div>
                <Label>Your price (optional)</Label>
                <Input
                  value={amountText}
                  inputMode="numeric"
                  aria-label="Amount"
                  onChange={(e) => setAmount(e.target.value)}
                  placeholder={picked?.priceAmount != null ? String(picked.priceAmount) : 'Let them name it'}
                />
              </div>
              <div>
                <Label>Currency</Label>
                <Select value={cur} onChange={(e) => setCurrency(e.target.value)}>
                  {currencies.map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </Select>
              </div>
            </div>
            <div style={{ fontSize: 12, color: theme.textDim, marginBottom: 14 }}>
              {!amountOk ? (
                <span style={{ color: theme.danger }}>Use a whole number, like 500.</span>
              ) : (
                `${creator.name} can accept at this price or name their own. Nothing is charged until you pay.`
              )}
            </div>
            <div style={{ marginBottom: 14 }}>
              <Label>Brief</Label>
              <Textarea
                value={brief}
                rows={4}
                maxLength={2000}
                onChange={(e) => setBrief(e.target.value)}
                placeholder="What you'd like the post to cover, links to include, and timing."
              />
            </div>
            <div style={{ marginBottom: 16 }}>
              <Label>Track it on an offering (optional)</Label>
              <Select value={offeringId} onChange={(e) => setOfferingId(e.target.value)} disabled={published.length === 0}>
                <option value="">{published.length === 0 ? 'No published offerings' : 'Don’t track it'}</option>
                {published.map((o) => (
                  <option key={o.id} value={o.id}>{o.title}</option>
                ))}
              </Select>
              <div style={{ fontSize: 12, color: theme.textDim, marginTop: 4 }}>
                {creator.name} becomes your partner on it when they accept, with a tracked link, so you see what the post drives.
                You can also add tracking later.
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <Button onClick={() => book.mutate()} disabled={!canBook}>
                {book.isPending ? 'Sending…' : 'Send request'}
              </Button>
              <Button variant="secondary" onClick={onClose}>Cancel</Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
