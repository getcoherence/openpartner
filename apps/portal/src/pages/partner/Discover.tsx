import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Globe } from 'lucide-react';
import { categoryLabel } from '@openpartner/db';
import { api, ApiError } from '../../api.js';
import { TenantLink } from '../../tenant-link.js';
import { Button, Card, EmptyState, ErrorBanner, Input, Label, Page, Select } from '../../ui.js';
import { theme } from '../../theme.js';
import {
  groupByBrand,
  summarizeBrandTerms,
  type BrandEntry,
  type SummaryTerms,
  type VendorFields,
} from '../creator/brand-summary.js';

/** A program as the Network lists it publicly. */
export interface NetworkProgram {
  id: string;
  title: string;
  description: string | null;
  productUrl: string;
  terms: SummaryTerms;
  createdAt: string;
}

type Brand = BrandEntry<NetworkProgram>;
type Sort = 'newest' | 'popular';

/** Discover's feed, one entry per brand so a brand with many programs takes
 *  one card. A Network predating /marketplace/brands 404s it; then its
 *  /offerings feed is grouped here instead, as creator Discover does. */
async function loadBrands(sort: Sort): Promise<Brand[]> {
  const qs = sort === 'newest' ? '' : `&sort=${sort}`;
  try {
    return (await api<{ brands: Brand[] }>(`/network/discover/brands?limit=100${qs}`)).brands;
  } catch (err) {
    if (!(err instanceof ApiError && err.status === 404)) throw err;
  }
  const { offerings } = await api<{ offerings: Array<NetworkProgram & VendorFields> }>(`/network/discover?limit=100${qs}`);
  return groupByBrand(offerings);
}

export function DiscoverPage() {
  const [q, setQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [sort, setSort] = useState<Sort>('newest');

  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedQ(q.trim()), 250);
    return () => window.clearTimeout(t);
  }, [q]);

  const { data, isLoading, error } = useQuery({
    queryKey: ['network-discover', sort],
    queryFn: () => loadBrands(sort),
    retry: false,
  });

  // A brand shows when any of its programs matches the search, and its card
  // says how many do.
  const shown = useMemo(() => {
    const query = debouncedQ.toLowerCase();
    return (data ?? [])
      .map((brand) => ({
        brand,
        matching: brand.offerings.filter(
          (o) => !query || [brand.vendorName, o.title, o.description ?? ''].join(' ').toLowerCase().includes(query),
        ).length,
      }))
      .filter((b) => b.matching > 0);
  }, [data, debouncedQ]);

  return (
    <Page title="Discover programs" subtitle="Browse partner programs across the OpenPartner Network.">
      <ErrorBanner error={error} />
      <Card>
        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 240 }}>
            <Label>Search</Label>
            <Input
              placeholder="Brand, program or description…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          <div style={{ minWidth: 160 }}>
            <Label>Sort</Label>
            <Select value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
              <option value="newest">Newest</option>
              <option value="popular">Most partners</option>
            </Select>
          </div>
        </div>
      </Card>

      <div style={{ height: 18 }} />

      {isLoading ? (
        <Card>Loading…</Card>
      ) : shown.length === 0 ? (
        <EmptyState
          title={debouncedQ ? `No matches for "${debouncedQ}"` : 'No programs yet'}
          hint={debouncedQ ? 'Try a different keyword.' : 'Check back soon — vendors are joining the Network all the time.'}
          icon={<Globe size={28} strokeWidth={1.25} />}
        />
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 16 }}>
          {shown.map(({ brand, matching }) =>
            brand.programCount === 1 ? (
              <ProgramCard key={brand.vendorId} brand={brand} program={brand.offerings[0]!} />
            ) : (
              <BrandCard key={brand.vendorId} brand={brand} matching={matching} />
            ),
          )}
        </div>
      )}
    </Page>
  );
}

/** A brand with one program: the program's own card. */
function ProgramCard({ brand, program: o }: { brand: Brand; program: NetworkProgram }) {
  return (
    <Card>
      <BrandLine brand={brand} />
      <h3 style={{ marginTop: 4, marginBottom: 8 }}>
        <TenantLink to={`/network/offerings/${o.id}`}>{o.title}</TenantLink>
      </h3>
      <TermsLines terms={[o.terms]} />
      {o.description && (
        <p style={{ fontSize: 14, color: theme.text, margin: '8px 0' }}>
          {o.description.slice(0, 180)}{o.description.length > 180 ? '…' : ''}
        </p>
      )}
      <div style={{ marginTop: 12 }}>
        <TenantLink to={`/network/offerings/${o.id}`}>
          <Button>View &amp; apply</Button>
        </TenantLink>
      </div>
    </Card>
  );
}

/** A brand with several programs: one card naming them, the terms summarised
 *  across them, opening the brand's page. While search narrows it, it says
 *  how many of its programs match. */
function BrandCard({ brand, matching }: { brand: Brand; matching: number }) {
  const to = `/network/vendors/${brand.vendorId}`;
  const names = [...new Set(brand.offerings.map((o) => o.title))].slice(0, 3);
  const more = brand.programCount - names.length;
  return (
    <Card>
      <BrandLine brand={brand} />
      <h3 style={{ marginTop: 4, marginBottom: 8 }}>
        <TenantLink to={to}>
          {names.join(', ')}
          {more > 0 && ` + ${more} more`}
        </TenantLink>
      </h3>
      <TermsLines terms={brand.offerings.map((o) => o.terms)} />
      <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 10 }}>
        <TenantLink to={to}>
          <Button>View programs</Button>
        </TenantLink>
        {matching < brand.offerings.length && (
          <span style={{ fontSize: 12, color: theme.textMuted }}>
            {matching} of {brand.offerings.length} match
          </span>
        )}
      </div>
    </Card>
  );
}

function BrandLine({ brand }: { brand: Brand }) {
  return (
    <div style={{ color: theme.textMuted, fontSize: 13 }}>
      <TenantLink to={`/network/vendors/${brand.vendorId}`} style={{ color: theme.textMuted }}>{brand.vendorName}</TenantLink>
      {brand.programCount > 1 && <> · {brand.programCount} programs</>}
      {brand.vendorPartnerCount > 0 && (
        <> · {brand.vendorPartnerCount} partner{brand.vendorPartnerCount === 1 ? '' : 's'}</>
      )}
      {/* Featured brands sort first; say so. */}
      {brand.featured && <span style={{ color: theme.accentText }}> · Featured</span>}
    </div>
  );
}

/** The commission, then the rest of the terms on one line, across `terms`
 *  (brand-summary.ts): exact when the programs agree, else the range. */
export function TermsLines({ terms }: { terms: SummaryTerms[] }) {
  const s = summarizeBrandTerms(terms);
  const rest = [s.reward, s.recruits, ...s.categories.map(categoryLabel), s.window].filter(Boolean);
  return (
    <>
      {s.commissionLine && <p style={{ fontSize: 13, color: theme.textMuted, margin: '4px 0' }}>{s.commissionLine}</p>}
      {rest.length > 0 && <p style={{ fontSize: 12, color: theme.textDim, margin: '4px 0' }}>{rest.join(' · ')}</p>}
    </>
  );
}
