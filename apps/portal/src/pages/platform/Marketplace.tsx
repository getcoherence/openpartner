import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp } from 'lucide-react';
import { theme } from '../../theme.js';
import { Button, Card, ErrorBanner, Page, SectionHeading, formatDate } from '../../ui.js';
import {
  papi,
  friendlyPlatformError,
  type FeaturedEntry,
  type NetworkVendor,
  type PlatformOperator,
} from './lib.js';

/**
 * Marketplace featured placement. Featured brands list above every other
 * program on the public /marketplace page (in their own section) and at the
 * top of creators' Discover feed, in the order set here.
 *
 * The Network owns marketplace listing, so this reads + writes its Vendor
 * rows through the ops API. Every change sends the whole featured list —
 * reordering is just a different order.
 */
export function MarketplacePage({ operator }: { operator: PlatformOperator }) {
  const qc = useQueryClient();
  const canWrite = operator.role === 'admin';

  const vendors = useQuery({
    queryKey: ['platform-marketplace'],
    queryFn: () => papi<{ vendors: NetworkVendor[] }>('/platform-admin/marketplace'),
  });

  const save = useMutation({
    mutationFn: (list: FeaturedEntry[]) =>
      papi('/platform-admin/marketplace/featured', { method: 'PUT', body: { vendors: list } }),
    onSettled: () => qc.invalidateQueries({ queryKey: ['platform-marketplace'] }),
  });

  const all = vendors.data?.vendors ?? [];
  // A Network that predates featured placement omits the fields entirely.
  const networkSupportsFeatured = all.length === 0 || all.some((v) => v.featuredRank !== undefined);
  const featured = all
    .filter((v) => v.featuredRank != null)
    .sort((a, b) => (a.featuredRank ?? 0) - (b.featuredRank ?? 0));
  const others = all
    .filter((v) => v.featuredRank == null && isListed(v))
    .sort((a, b) => nameOf(a).localeCompare(nameOf(b)));

  const current: FeaturedEntry[] = featured.map((v) => ({ id: v.id, until: v.featuredUntil ?? null }));
  const busy = save.isPending;

  function move(index: number, delta: -1 | 1) {
    const next = [...current];
    const [item] = next.splice(index, 1);
    next.splice(index + delta, 0, item!);
    save.mutate(next);
  }

  return (
    <Page
      title="Marketplace"
      subtitle="Featured brands sit above every other program on the public marketplace and at the top of creators’ Discover feed."
    >
      {!canWrite && (
        <div
          style={{
            background: theme.infoSoft,
            border: `1px solid ${theme.info}44`,
            color: theme.info,
            padding: '10px 14px',
            borderRadius: theme.radiusSm,
            fontSize: 13,
            marginBottom: 16,
          }}
        >
          You’re signed in as a read-only operator. Featuring is disabled.
        </div>
      )}

      {!networkSupportsFeatured && (
        <div
          style={{
            background: theme.warnSoft,
            color: theme.warn,
            padding: '10px 14px',
            borderRadius: theme.radiusSm,
            fontSize: 13,
            marginBottom: 16,
          }}
        >
          The Network hasn’t been updated for featured placement yet, so changes here won’t save.
        </div>
      )}

      <ErrorBanner error={save.error ? friendlyPlatformError(save.error) : vendors.error} />

      {vendors.isLoading ? (
        <Card>Loading…</Card>
      ) : (
        <>
          <SectionHeading>Featured</SectionHeading>
          {featured.length === 0 ? (
            <Card style={{ color: theme.textDim, fontSize: 13.5, marginBottom: 28 }}>
              Nothing featured. Feature a brand below to pin it above every other listing.
            </Card>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 28 }}>
              {featured.map((v, i) => (
                <VendorRow key={v.id} vendor={v} rank={i + 1}>
                  {canWrite && (
                    <>
                      <UntilInput
                        value={v.featuredUntil ?? null}
                        disabled={busy}
                        onCommit={(until) =>
                          save.mutate(current.map((e) => (e.id === v.id ? { ...e, until } : e)))
                        }
                      />
                      <IconButton label="Move up" disabled={busy || i === 0} onClick={() => move(i, -1)}>
                        <ArrowUp size={14} />
                      </IconButton>
                      <IconButton
                        label="Move down"
                        disabled={busy || i === featured.length - 1}
                        onClick={() => move(i, 1)}
                      >
                        <ArrowDown size={14} />
                      </IconButton>
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={busy}
                        onClick={() => save.mutate(current.filter((e) => e.id !== v.id))}
                      >
                        Unfeature
                      </Button>
                    </>
                  )}
                </VendorRow>
              ))}
            </div>
          )}

          <SectionHeading>Listed brands</SectionHeading>
          {others.length === 0 ? (
            <Card style={{ color: theme.textDim, fontSize: 13.5 }}>No other brands are listed on the marketplace.</Card>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {others.map((v) => (
                <VendorRow key={v.id} vendor={v}>
                  {canWrite && (
                    <Button
                      size="sm"
                      disabled={busy || !networkSupportsFeatured || current.length >= 24}
                      onClick={() => save.mutate([...current, { id: v.id, until: null }])}
                    >
                      Feature
                    </Button>
                  )}
                </VendorRow>
              ))}
            </div>
          )}
        </>
      )}
    </Page>
  );
}

/** On the marketplace right now: live credential, approved, something published. */
function isListed(v: NetworkVendor): boolean {
  return v.status === 'active' && (v.reviewStatus ?? 'approved') === 'approved' && (v.publishedOfferingCount ?? 0) > 0;
}

function nameOf(v: NetworkVendor): string {
  return v.displayName ?? v.id;
}

function VendorRow({ vendor: v, rank, children }: { vendor: NetworkVendor; rank?: number; children?: React.ReactNode }) {
  const programs = v.publishedOfferingCount ?? 0;
  const partners = v.partnerCount ?? 0;
  const expired = !!v.featuredUntil && new Date(v.featuredUntil).getTime() <= Date.now();
  // Why a featured brand isn't actually showing — featuring never overrides
  // the listing rules.
  const hiddenReason =
    rank === undefined || isListed(v)
      ? null
      : v.status !== 'active'
        ? `Not shown — brand is ${v.status}`
        : (v.reviewStatus ?? 'approved') !== 'approved'
          ? 'Not shown — brand is awaiting review'
          : 'Not shown — no published programs';
  return (
    <Card style={{ padding: '14px 16px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        {rank !== undefined && (
          <div style={{ width: 18, textAlign: 'center', fontSize: 13, fontWeight: 600, color: theme.textDim }}>{rank}</div>
        )}
        <Logo url={v.logoUrl ?? null} name={nameOf(v)} />
        <div style={{ flex: 1, minWidth: 160 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 14.5, fontWeight: 600 }}>{nameOf(v)}</span>
            {expired && <Pill>Expired</Pill>}
            {hiddenReason && <Pill>{hiddenReason}</Pill>}
          </div>
          <div style={{ fontSize: 12, color: theme.textDim, marginTop: 3 }}>
            {programs} program{programs === 1 ? '' : 's'} · {partners} partner{partners === 1 ? '' : 's'}
            {rank !== undefined && (v.featuredUntil ? ` · ends ${formatDate(v.featuredUntil)}` : ' · no end date')}
          </div>
        </div>
        {children && <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>{children}</div>}
      </div>
    </Card>
  );
}

/**
 * Optional end date for a placement, saved explicitly. Chrome's date input
 * reports intermediate values while you type (year "0002", or '' for an
 * impossible day) and each save is a Network write, so nothing commits until
 * Save / Enter. The placement runs through the end of the chosen day, UTC.
 */
function UntilInput({
  value,
  disabled,
  onCommit,
}: {
  value: string | null;
  disabled: boolean;
  onCommit: (until: string | null) => void;
}) {
  const saved = value ? value.slice(0, 10) : '';
  const [draft, setDraft] = useState(saved);
  useEffect(() => setDraft(saved), [saved]);
  const dirty = draft !== saved;
  const save = () => onCommit(draft ? `${draft}T23:59:59Z` : null);

  return (
    <>
      <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: theme.textDim }}>
        Ends
        <input
          type="date"
          aria-label="Featured until"
          value={draft}
          disabled={disabled}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && dirty) save();
          }}
          style={{
            padding: '5px 8px',
            fontSize: 12.5,
            background: theme.surface2,
            border: `1px solid ${theme.border}`,
            borderRadius: theme.radiusSm,
            color: theme.text,
            colorScheme: 'dark',
          }}
        />
      </label>
      {dirty && (
        <Button size="sm" disabled={disabled} onClick={save}>
          {draft ? 'Save date' : 'Remove date'}
        </Button>
      )}
    </>
  );
}

function Logo({ url, name }: { url: string | null; name: string }) {
  if (url) {
    return (
      <img
        src={url}
        alt=""
        style={{ width: 32, height: 32, borderRadius: 7, objectFit: 'contain', background: '#fff', flexShrink: 0 }}
      />
    );
  }
  return (
    <div
      aria-hidden
      style={{
        width: 32,
        height: 32,
        borderRadius: 7,
        background: theme.surface2,
        color: theme.textDim,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 14,
        fontWeight: 600,
        flexShrink: 0,
      }}
    >
      {(name.trim()[0] ?? '?').toUpperCase()}
    </div>
  );
}

function Pill({ children }: { children: React.ReactNode }) {
  return (
    <span
      style={{
        fontSize: 10.5,
        fontWeight: 700,
        textTransform: 'uppercase',
        letterSpacing: '0.04em',
        color: theme.warn,
        background: theme.warnSoft,
        borderRadius: 4,
        padding: '2px 6px',
      }}
    >
      {children}
    </span>
  );
}

function IconButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 30,
        height: 30,
        background: 'transparent',
        color: theme.text,
        border: `1px solid ${theme.border}`,
        borderRadius: theme.radiusSm,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.4 : 1,
      }}
    >
      {children}
    </button>
  );
}
