/**
 * Book a creator from Discover creators or their storefront page: pick one of their storefront
 * packages (or a custom collaboration), the offering it's for, and the
 * amount you'll pay. The creator accepts in their inbox (becoming your
 * partner on that offering, with a tracked link), delivers the post, and
 * you approve it on Network → Bookings; the Network then pays the amount
 * as a bonus through your program.
 */
import { useEffect, useMemo, useState } from 'react';
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
  vendor_unreachable: 'The Network couldn’t reach your OpenPartner instance. Try again in a moment.',
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

  const [packageId, setPackageId] = useState('');
  const [offeringId, setOfferingId] = useState('');
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState('USD');
  const [brief, setBrief] = useState('');

  useEffect(() => {
    if (!offeringId && published.length === 1) setOfferingId(published[0]!.id);
  }, [offeringId, published]);

  // Packages arrive after the dialog opens; apply the starting one once.
  const [preselected, setPreselected] = useState(false);
  useEffect(() => {
    if (preselected || !initialPackageId || packages.length === 0) return;
    setPreselected(true);
    const p = packages.find((x) => x.id === initialPackageId);
    if (!p) return;
    setPackageId(p.id);
    setCurrency(p.currency);
    if (p.priceAmount != null) setAmount(String(p.priceAmount));
  }, [preselected, initialPackageId, packages]);

  // Picking a package fills in its price as the starting amount.
  function pickPackage(id: string) {
    setPackageId(id);
    const p = packages.find((x) => x.id === id);
    if (p) {
      setCurrency(p.currency);
      if (p.priceAmount != null) setAmount(String(p.priceAmount));
    }
  }

  const book = useMutation({
    mutationFn: () =>
      api<{ booking: { id: string } }>('/admin/network/bookings', {
        method: 'POST',
        body: {
          creatorId: creator.id,
          offeringId,
          packageId: packageId || null,
          amount: Number(amount),
          currency,
          brief: brief.trim(),
        },
      }),
  });
  const authorize = useMutation({
    mutationFn: () => api('/config/network/authorize-bonuses', { method: 'POST', body: {} }),
    onSuccess: () => book.reset(),
  });

  const code = networkErrorCode(book.error);
  const amountOk = /^\d{1,8}$/.test(amount.trim()) && Number(amount) >= 1;
  const canBook = !!offeringId && amountOk && brief.trim().length >= 20 && !book.isPending;
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
        <div style={{ fontSize: 15, fontWeight: 500, marginBottom: 4 }}>Book @{creator.handle}</div>
        <p style={{ fontSize: 13, color: theme.textMuted, margin: '0 0 16px', lineHeight: 1.5 }}>
          A tracked deal: when {creator.name} accepts, they become your partner on the offering with a tracked link.
          After they deliver, approve it under Network → Bookings and the amount is paid as a bonus through your program.
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
              Booking sent. {creator.name} has it in their inbox.
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <TenantLink to="/admin/network/bookings" style={{ textDecoration: 'none' }}>
                <Button>View bookings</Button>
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
            {code === 'bonuses_scope_missing' ? (
              <div style={{ background: alpha(theme.info, 0.08), border: `1px solid ${alpha(theme.info, 0.333)}`, borderRadius: theme.radiusSm, padding: 12, fontSize: 13, marginBottom: 14 }}>
                <div style={{ marginBottom: 8 }}>
                  Bookings are paid as bonuses through your program, and your Network connection doesn&rsquo;t have permission to record
                  a bonus yet. Re-authorize once, then book again.
                </div>
                <ErrorBanner error={authorize.error} />
                <Button size="sm" onClick={() => authorize.mutate()} disabled={authorize.isPending}>
                  {authorize.isPending ? 'Authorizing…' : 'Re-authorize'}
                </Button>
              </div>
            ) : (
              book.error && <ErrorBanner error={code && ERROR_TEXT[code] ? ERROR_TEXT[code] : book.error} />
            )}
            <div style={{ marginBottom: 14 }}>
              <Label>Package</Label>
              <Select value={packageId} onChange={(e) => pickPackage(e.target.value)}>
                <option value="">Custom collaboration</option>
                {packages.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.title} — {formatPackagePrice(p)}
                  </option>
                ))}
              </Select>
            </div>
            <div style={{ marginBottom: 14 }}>
              <Label>Offering</Label>
              {published.length === 0 ? (
                <p style={{ fontSize: 13, color: theme.textMuted, margin: '6px 0 0' }}>
                  No published offerings yet. <TenantLink to="/admin/network" style={{ color: theme.accentText }}>Publish one</TenantLink> first — the
                  creator&rsquo;s tracked link points at it.
                </p>
              ) : (
                <Select value={offeringId} onChange={(e) => setOfferingId(e.target.value)}>
                  <option value="">— pick an offering —</option>
                  {published.map((o) => (
                    <option key={o.id} value={o.id}>{o.title}</option>
                  ))}
                </Select>
              )}
            </div>
            <div className="op-grid-collapse" style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 12, marginBottom: 14 }}>
              <div>
                <Label>Amount you&rsquo;ll pay</Label>
                <Input value={amount} inputMode="numeric" aria-label="Amount" onChange={(e) => setAmount(e.target.value)} placeholder="500" />
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
            {amount.trim() !== '' && !amountOk && (
              <div style={{ fontSize: 13, color: theme.danger, marginTop: -6, marginBottom: 12 }}>Use a whole number, like 500.</div>
            )}
            <div style={{ marginBottom: 16 }}>
              <Label>Brief</Label>
              <Textarea
                value={brief}
                rows={4}
                maxLength={2000}
                onChange={(e) => setBrief(e.target.value)}
                placeholder="What you'd like the post to cover, links to include, and timing."
              />
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <Button onClick={() => book.mutate()} disabled={!canBook}>
                {book.isPending ? 'Booking…' : 'Send booking'}
              </Button>
              <Button variant="secondary" onClick={onClose}>Cancel</Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
