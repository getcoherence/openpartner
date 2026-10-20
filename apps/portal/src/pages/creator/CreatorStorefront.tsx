/**
 * /creator/storefront — the creator's rate card. Turn bookings on, add
 * priced packages, order them. Packages show on the public profile
 * (/creators/:handle) while bookings are on; brands request them from there
 * and the requests land in /creator/bookings.
 */
import { useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, ExternalLink, Store } from 'lucide-react';
import { Button, Card, EmptyState, ErrorBanner, Input, Label, Page, Select, StatusPill, Textarea } from '../../ui.js';
import { theme } from '../../theme.js';
import { creatorApi } from './creator-api.js';
import { formatPackagePrice, PACKAGE_CURRENCIES, PLATFORM_LABELS, type OwnPackage } from './storefront-shared.js';

interface Storefront {
  bookingsOpen: boolean;
  handle: string | null;
  profileComplete: boolean;
  maxPackages: number;
  packages: OwnPackage[];
}

const QUERY_KEY = ['creator-storefront'];

export function CreatorStorefrontPage() {
  const qc = useQueryClient();
  const sf = useQuery({
    queryKey: QUERY_KEY,
    queryFn: () => creatorApi<Storefront>('/creators/me/storefront'),
    retry: false,
  });
  const [editing, setEditing] = useState<OwnPackage | 'new' | null>(null);

  const toggle = useMutation({
    mutationFn: (bookingsOpen: boolean) => creatorApi('/creators/me/storefront', { method: 'PUT', body: { bookingsOpen } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: QUERY_KEY }),
  });
  const reorder = useMutation({
    mutationFn: (ids: string[]) => creatorApi('/creators/me/packages/order', { method: 'POST', body: { ids } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: QUERY_KEY }),
  });

  const data = sf.data;
  const packages = data?.packages ?? [];
  const atCap = !!data && packages.length >= data.maxPackages;

  function move(index: number, delta: -1 | 1) {
    const ids = packages.map((p) => p.id);
    const j = index + delta;
    if (j < 0 || j >= ids.length) return;
    [ids[index], ids[j]] = [ids[j]!, ids[index]!];
    reorder.mutate(ids);
  }

  return (
    <Page
      title="Storefront"
      subtitle="List what you offer brands — sponsored posts, videos, newsletter spots — and take booking requests from your public profile."
      actions={
        <Button onClick={() => setEditing('new')} disabled={atCap || editing === 'new'}>
          Add package
        </Button>
      }
    >
      <ErrorBanner error={sf.error ?? toggle.error ?? reorder.error} />
      {sf.isLoading || !data ? (
        sf.isLoading ? <Card>Loading…</Card> : null
      ) : (
        <>
          <BookingsCard
            storefront={data}
            pending={toggle.isPending}
            onToggle={() => toggle.mutate(!data.bookingsOpen)}
          />
          <div style={{ height: 14 }} />

          {editing === 'new' && (
            <PackageForm
              onDone={() => {
                setEditing(null);
                qc.invalidateQueries({ queryKey: QUERY_KEY });
              }}
              onCancel={() => setEditing(null)}
            />
          )}

          {packages.length === 0 && editing !== 'new' ? (
            <EmptyState
              title="No packages yet"
              hint="Add what you sell, with a price — e.g. “Sponsored LinkedIn post — $500”. You can also leave the price as “on request”."
              icon={<Store size={28} strokeWidth={1.25} />}
            />
          ) : (
            <div style={{ display: 'grid', gap: 10 }}>
              {packages.map((p, i) =>
                editing !== 'new' && editing?.id === p.id ? (
                  <PackageForm
                    key={p.id}
                    existing={p}
                    onDone={() => {
                      setEditing(null);
                      qc.invalidateQueries({ queryKey: QUERY_KEY });
                    }}
                    onCancel={() => setEditing(null)}
                  />
                ) : (
                  <PackageCard
                    key={p.id}
                    pkg={p}
                    first={i === 0}
                    last={i === packages.length - 1}
                    busy={reorder.isPending}
                    onEdit={() => setEditing(p)}
                    onMove={(d) => move(i, d)}
                  />
                ),
              )}
            </div>
          )}
          {atCap && (
            <p style={{ color: theme.textMuted, fontSize: 13, marginTop: 12 }}>
              That&rsquo;s the maximum of {data.maxPackages} packages. Delete one to add another.
            </p>
          )}
        </>
      )}
    </Page>
  );
}

function BookingsCard({ storefront, pending, onToggle }: { storefront: Storefront; pending: boolean; onToggle: () => void }) {
  const publicPath = storefront.handle ? `/creators/${storefront.handle}` : null;
  return (
    <Card>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 220 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 15, fontWeight: 500 }}>Booking requests</span>
            <StatusPill status={storefront.bookingsOpen ? 'active' : 'paused'} />
          </div>
          <div style={{ fontSize: 13, color: theme.textMuted, marginTop: 4 }}>
            {storefront.bookingsOpen
              ? 'Your packages and a request form are on your public profile. Brands confirm their email before a request reaches you.'
              : 'Turn on to show your packages and a request form on your public profile.'}
          </div>
        </div>
        <Button variant={storefront.bookingsOpen ? 'secondary' : 'primary'} onClick={onToggle} disabled={pending}>
          {storefront.bookingsOpen ? 'Pause bookings' : 'Turn on bookings'}
        </Button>
      </div>
      {!storefront.profileComplete ? (
        <div style={{ marginTop: 14, fontSize: 13, color: theme.warn, background: theme.warnSoft, borderRadius: theme.radiusSm, padding: '10px 12px' }}>
          Your profile isn&rsquo;t complete, so it has no public page yet and brands can&rsquo;t see your storefront.{' '}
          <Link to="/creator/profile" style={{ color: theme.warn, fontWeight: 600 }}>Finish your profile</Link>
        </div>
      ) : (
        publicPath && (
          <div style={{ marginTop: 14, fontSize: 13, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ color: theme.textMuted }}>Your public page:</span>
            <a
              href={publicPath}
              target="_blank"
              rel="noopener noreferrer"
              style={{ fontFamily: theme.fontMono, color: theme.accentText, display: 'inline-flex', alignItems: 'center', gap: 4 }}
            >
              {window.location.host}
              {publicPath}
              <ExternalLink size={12} />
            </a>
          </div>
        )
      )}
    </Card>
  );
}

function PackageCard({
  pkg,
  first,
  last,
  busy,
  onEdit,
  onMove,
}: {
  pkg: OwnPackage;
  first: boolean;
  last: boolean;
  busy: boolean;
  onEdit: () => void;
  onMove: (delta: -1 | 1) => void;
}) {
  const qc = useQueryClient();
  const remove = useMutation({
    mutationFn: () => creatorApi(`/creators/me/packages/${pkg.id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: QUERY_KEY }),
  });
  return (
    <Card>
      <ErrorBanner error={remove.error} />
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 15, fontWeight: 500 }}>{pkg.title}</span>
            {!pkg.published && <StatusPill status="draft" />}
            {pkg.platform && (
              <span style={{ fontSize: 12, color: theme.textMuted }}>{PLATFORM_LABELS[pkg.platform] ?? pkg.platform}</span>
            )}
          </div>
          {pkg.description && (
            <div style={{ fontSize: 13, color: theme.textMuted, marginTop: 6, whiteSpace: 'pre-wrap' }}>{pkg.description}</div>
          )}
        </div>
        <div style={{ fontSize: 15, fontWeight: 600, whiteSpace: 'nowrap' }}>{formatPackagePrice(pkg)}</div>
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
        <Button size="sm" variant="secondary" onClick={onEdit}>Edit</Button>
        <Button size="sm" variant="ghost" onClick={() => onMove(-1)} disabled={first || busy} icon={<ArrowUp size={14} />}>Up</Button>
        <Button size="sm" variant="ghost" onClick={() => onMove(1)} disabled={last || busy} icon={<ArrowDown size={14} />}>Down</Button>
        <div style={{ flex: 1 }} />
        <Button
          size="sm"
          variant="danger"
          disabled={remove.isPending}
          onClick={() => {
            if (window.confirm(`Delete “${pkg.title}”? Requests already sent for it keep what was asked for.`)) remove.mutate();
          }}
        >
          Delete
        </Button>
      </div>
    </Card>
  );
}

function PackageForm({ existing, onDone, onCancel }: { existing?: OwnPackage; onDone: () => void; onCancel: () => void }) {
  const [title, setTitle] = useState(existing?.title ?? '');
  const [description, setDescription] = useState(existing?.description ?? '');
  const [platform, setPlatform] = useState(existing?.platform ?? '');
  const [price, setPrice] = useState(existing?.priceAmount != null ? String(existing.priceAmount) : '');
  const [priceIsFrom, setPriceIsFrom] = useState(existing?.priceIsFrom ?? false);
  const [currency, setCurrency] = useState(existing?.currency ?? 'USD');
  const [published, setPublished] = useState(existing?.published ?? true);

  const priceValid = price.trim() === '' || /^\d{1,8}$/.test(price.trim());
  const save = useMutation({
    mutationFn: () => {
      const body = {
        title: title.trim(),
        description: description.trim() || null,
        platform: platform || null,
        priceAmount: price.trim() === '' ? null : Number(price.trim()),
        priceIsFrom: price.trim() === '' ? false : priceIsFrom,
        currency,
        published,
      };
      return existing
        ? creatorApi(`/creators/me/packages/${existing.id}`, { method: 'PATCH', body })
        : creatorApi('/creators/me/packages', { method: 'POST', body });
    },
    onSuccess: onDone,
  });

  const currencies = PACKAGE_CURRENCIES.includes(currency as (typeof PACKAGE_CURRENCIES)[number])
    ? PACKAGE_CURRENCIES
    : [currency, ...PACKAGE_CURRENCIES];

  return (
    <Card style={{ marginBottom: 10 }}>
      <div style={{ fontSize: 15, fontWeight: 500, marginBottom: 14 }}>{existing ? 'Edit package' : 'New package'}</div>
      <ErrorBanner error={save.error} />
      <div style={{ display: 'grid', gap: 14 }}>
        <div>
          <Label>Title</Label>
          <Input value={title} maxLength={80} onChange={(e) => setTitle(e.target.value)} placeholder="Sponsored LinkedIn post" />
        </div>
        <div>
          <Label>Description</Label>
          <Textarea
            value={description}
            maxLength={600}
            rows={3}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What the brand gets: format, length, links, timing."
          />
        </div>
        <div className="op-grid-collapse" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
          <div>
            <Label>Platform</Label>
            <Select value={platform} onChange={(e) => setPlatform(e.target.value)}>
              <option value="">Any</option>
              {Object.entries(PLATFORM_LABELS).map(([k, label]) => (
                <option key={k} value={k}>{label}</option>
              ))}
            </Select>
          </div>
          <div>
            <Label>Price</Label>
            <Input
              value={price}
              inputMode="numeric"
              onChange={(e) => setPrice(e.target.value)}
              placeholder="On request"
            />
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
        {!priceValid && <div style={{ fontSize: 13, color: theme.danger }}>Use a whole number, like 500.</div>}
        <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', fontSize: 13 }}>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, opacity: price.trim() === '' ? 0.5 : 1 }}>
            <input
              type="checkbox"
              checked={priceIsFrom}
              disabled={price.trim() === ''}
              onChange={(e) => setPriceIsFrom(e.target.checked)}
            />
            Show as &ldquo;From&rdquo; price
          </label>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <input type="checkbox" checked={published} onChange={(e) => setPublished(e.target.checked)} />
            Show on my public page
          </label>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
        <Button onClick={() => save.mutate()} disabled={!title.trim() || !priceValid || save.isPending}>
          {save.isPending ? 'Saving…' : existing ? 'Save' : 'Add package'}
        </Button>
        <Button variant="secondary" onClick={onCancel}>Cancel</Button>
      </div>
    </Card>
  );
}
