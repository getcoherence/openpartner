/**
 * Per-program (per-partnership) detail page.
 *
 * Layout mirrors Dub's program page: top header (brand + share URL +
 * rewards), then a tab strip with Overview / Earnings / Events /
 * Customers. Each tab is a separate sub-page of this component, scoped
 * to a single Partnership row (so multi-program creators get isolated
 * stats per program).
 *
 * Data flows entirely through the Network's federated proxies; the
 * vendor instance owns the underlying Click / Event / Commission
 * tables. See openpartner-network/src/routes/creator-domains.ts for
 * the four pulled endpoints (timeseries / events / customers /
 * commissions).
 */

import { useMemo, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, NavLink, Outlet, Route, Routes, useNavigate, useOutletContext, useParams } from 'react-router-dom';
import { ArrowLeft, ArrowUpRight } from 'lucide-react';
import { Card, EmptyState, ErrorBanner, Page, formatDate, money, shortId } from '../../ui.js';
import { theme } from '../../theme.js';
import { creatorApi } from './creator-api.js';

// ---------- Shared types (mirror federation responses) ----------

interface Coupon {
  id: string;
  code: string;
  programId: string;
  redemptions90d: number;
  revenue90d: number;
  canEdit: boolean;
  deactivatedAt: string | null;
}

interface Partnership {
  id: string;
  vendorId: string;
  offeringId: string;
  creatorSlug: string;
  publicShareUrl: string;
  status: string;
  createdAt: string;
  vendorName: string;
  offeringTitle: string | null;
  shareUrl: string;
  customDomain: string | null;
  coupons: Coupon[];
}

interface TimeseriesBucket {
  bucket: string;
  clicks: number;
  leads: number;
  sales: number;
  revenue: number;
  earnings: number;
}

interface Timeseries {
  partnerId: string;
  since: string;
  until: string;
  bucket: 'day' | 'week';
  buckets: TimeseriesBucket[];
}

interface PartnerEvent {
  attributionId: string;
  weight: number;
  model: string;
  eventId: string;
  type: string;
  value: number | null;
  currency: string | null;
  ts: string;
  userId: string;
  click: {
    id: string;
    linkKey: string | null;
    referer: string | null;
    landingUrl: string | null;
    ts: string | null;
  } | null;
}

interface Customer {
  userId: string;
  firstEventAt: string;
  lastEventAt: string;
  eventCount: number;
  revenue: number;
}

interface CommissionRow {
  id: string;
  amount: string;
  currency: string | null;
  status: 'accrued' | 'approved' | 'paid' | 'reversed';
  accruedAt: string;
  approvedAt: string | null;
  paidAt: string | null;
  programId: string | null;
  campaignName: string | null;
  matureAt: string | null;
}

// ---------- Page shell + tab routing ----------

export function CreatorProgramDetailPage() {
  return (
    <Routes>
      <Route element={<ProgramShell />}>
        <Route index element={<OverviewTab />} />
        <Route path="earnings" element={<EarningsTab />} />
        <Route path="analytics" element={<AnalyticsTab />} />
        <Route path="events" element={<EventsTab />} />
        <Route path="customers" element={<CustomersTab />} />
        <Route path="resources" element={<ResourcesTab />} />
      </Route>
    </Routes>
  );
}

// ---------- Brand-info federation (Resources tab + support footer) ----------

interface BrandAsset {
  id: string;
  kind: 'image' | 'document' | 'snippet';
  label: string;
  description: string | null;
  url: string | null;
  body: string | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

interface BrandInfo {
  brand: {
    displayName: string | null;
    logoUrl: string | null;
    brandColor: string | null;
    programTermsUrl: string | null;
    supportEmail: string | null;
  };
  assets: BrandAsset[];
}

/** Single fetch hook the Resources tab + support footer both consume.
 *  Cached at module scope by partnershipId so jumping between tabs doesn't
 *  refire the federation call. */
function useBrandInfo(partnershipId: string) {
  return useQuery({
    queryKey: ['creator-program-brand-info', partnershipId],
    queryFn: () =>
      creatorApi<BrandInfo>(`/creators/me/partnerships/${partnershipId}/brand-info`),
    retry: false,
    staleTime: 5 * 60_000,
  });
}

function ProgramShell() {
  const { partnershipId = '' } = useParams();
  const nav = useNavigate();

  // Pull the partnerships list (cached across the tabs) and find ours.
  // Re-using the same query key the share-links page populates means
  // tab switches are instant when the user came from there.
  const list = useQuery({
    queryKey: ['creator-partnerships'],
    queryFn: () => creatorApi<{ partnerships: Partnership[] }>('/creators/me/partnerships'),
    retry: false,
  });

  const partnership = list.data?.partnerships.find((p) => p.id === partnershipId);

  if (list.isLoading) return <Page title="Program"><Card>Loading…</Card></Page>;
  if (list.error) return <Page title="Program"><ErrorBanner error={list.error} /></Page>;
  if (!partnership) {
    return (
      <Page title="Program">
        <Card>
          <p style={{ color: theme.textMuted, fontSize: 13 }}>
            Partnership not found, or you don&rsquo;t have access. <button onClick={() => nav('/creator/affiliations')} style={{ background: 'transparent', border: 'none', color: theme.accent, cursor: 'pointer', padding: 0, fontSize: 13 }}>Back to partnerships</button>
          </p>
        </Card>
      </Page>
    );
  }

  return (
    <Page title={partnership.vendorName} subtitle={partnership.offeringTitle ?? undefined}>
      <div style={{ marginBottom: 14 }}>
        <Link to="/creator/affiliations" style={{ color: theme.textMuted, fontSize: 13, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <ArrowLeft size={14} /> All partnerships
        </Link>
      </div>

      <ProgramHeader partnership={partnership} />
      <TabStrip partnershipId={partnership.id} />
      <Outlet context={{ partnership }} />
      <ProgramSupportFooter partnershipId={partnership.id} vendorName={partnership.vendorName} />
    </Page>
  );
}

/** Brand-provided contact + terms link rendered below every tab. The
 *  vendor sets supportEmail + programTermsUrl in their admin Settings;
 *  the Network federates them through /brand-info. Renders nothing when
 *  neither field is set so we don't paint an empty contact card. */
function ProgramSupportFooter({
  partnershipId,
  vendorName,
}: {
  partnershipId: string;
  vendorName: string;
}) {
  const info = useBrandInfo(partnershipId);
  const brand = info.data?.brand;
  if (!brand) return null;
  if (!brand.supportEmail && !brand.programTermsUrl) return null;

  return (
    <div
      style={{
        marginTop: 18,
        paddingTop: 14,
        borderTop: `1px solid ${theme.borderSubtle}`,
        display: 'flex',
        alignItems: 'center',
        gap: 16,
        flexWrap: 'wrap',
        fontSize: 12,
        color: theme.textMuted,
      }}
    >
      <span>Program support from {vendorName}:</span>
      {brand.supportEmail && (
        <a
          href={`mailto:${brand.supportEmail}`}
          style={{ color: theme.accent, textDecoration: 'none' }}
        >
          {brand.supportEmail}
        </a>
      )}
      {brand.programTermsUrl && (
        <a
          href={brand.programTermsUrl}
          target="_blank"
          rel="noreferrer noopener"
          style={{ color: theme.accent, textDecoration: 'none' }}
        >
          Program terms ↗
        </a>
      )}
    </div>
  );
}

/** Brand + share URL + rewards summary card. The Dub equivalent of
 *  the gradient hero block at the top of the program page. */
function ProgramHeader({ partnership }: { partnership: Partnership }) {
  const activeCoupons = partnership.coupons.filter((c) => !c.deactivatedAt);
  return (
    <Card style={{ marginBottom: 14 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 280 }}>
          <div style={{ fontSize: 11, color: theme.textDim, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>
            Share link
          </div>
          <code style={{ fontSize: 13, color: theme.text, fontFamily: theme.fontMono, wordBreak: 'break-all' }}>
            {partnership.shareUrl}
          </code>
          {activeCoupons.length > 0 && (
            <>
              <div style={{ fontSize: 11, color: theme.textDim, textTransform: 'uppercase', letterSpacing: '0.05em', marginTop: 12, marginBottom: 4 }}>
                Coupon code{activeCoupons.length === 1 ? '' : 's'}
              </div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {activeCoupons.map((c) => (
                  <code key={c.id} style={{
                    fontSize: 12,
                    fontFamily: theme.fontMono,
                    padding: '2px 8px',
                    background: theme.surface2,
                    border: `1px solid ${theme.borderSubtle}`,
                    borderRadius: 6,
                    color: theme.text,
                  }}>{c.code}</code>
                ))}
              </div>
            </>
          )}
        </div>
        <Link
          to="/creator/links"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            color: theme.accent,
            fontSize: 12,
            textDecoration: 'none',
          }}
        >
          Manage link & codes <ArrowUpRight size={12} />
        </Link>
      </div>
    </Card>
  );
}

function TabStrip({ partnershipId }: { partnershipId: string }) {
  const tabs: Array<{ to: string; label: string; end?: boolean }> = [
    { to: `/creator/programs/${partnershipId}`, label: 'Overview', end: true },
    { to: `/creator/programs/${partnershipId}/earnings`, label: 'Earnings' },
    { to: `/creator/programs/${partnershipId}/analytics`, label: 'Analytics' },
    { to: `/creator/programs/${partnershipId}/events`, label: 'Events' },
    { to: `/creator/programs/${partnershipId}/customers`, label: 'Customers' },
    { to: `/creator/programs/${partnershipId}/resources`, label: 'Resources' },
  ];
  return (
    <div style={{ display: 'flex', gap: 4, borderBottom: `1px solid ${theme.borderSubtle}`, marginBottom: 14 }}>
      {tabs.map((t) => (
        <NavLink
          key={t.to}
          to={t.to}
          end={t.end}
          style={({ isActive }) => ({
            padding: '8px 14px',
            fontSize: 13,
            color: isActive ? theme.text : theme.textMuted,
            borderBottom: `2px solid ${isActive ? theme.accent : 'transparent'}`,
            marginBottom: -1,
            fontWeight: isActive ? 500 : 400,
          })}
        >
          {t.label}
        </NavLink>
      ))}
    </div>
  );
}

// Helper: extract the partnership from Outlet context. Each tab uses
// this instead of re-fetching, since the shell already loaded it.
function useOutletPartnership(): Partnership {
  return useOutletContext<{ partnership: Partnership }>().partnership;
}

// ---------- Overview tab ----------

const RANGE_OPTIONS = [
  { label: '7 days', days: 7 },
  { label: '30 days', days: 30 },
  { label: '90 days', days: 90 },
  { label: '12 months', days: 365 },
] as const;

function OverviewTab() {
  const partnership = useOutletPartnership();
  const [rangeDays, setRangeDays] = useState<number>(30);
  const since = useMemo(() => new Date(Date.now() - rangeDays * 24 * 60 * 60 * 1000).toISOString(), [rangeDays]);

  const ts = useQuery({
    queryKey: ['creator-program-timeseries', partnership.id, rangeDays],
    queryFn: () =>
      creatorApi<Timeseries>(`/creators/me/partnerships/${partnership.id}/timeseries?since=${encodeURIComponent(since)}`),
    retry: false,
    staleTime: 60_000,
  });

  const recentCommissions = useQuery({
    queryKey: ['creator-program-commissions', partnership.id, 'recent'],
    queryFn: () =>
      creatorApi<{ commissions: CommissionRow[] }>(`/creators/me/partnerships/${partnership.id}/commissions?limit=10`),
    retry: false,
    staleTime: 60_000,
  });

  // Aggregate the buckets into top-line totals — same numbers Dub
  // shows above each chart. Cheap; no need to round-trip a separate
  // aggregate endpoint.
  const totals = useMemo(() => {
    const out = { clicks: 0, leads: 0, sales: 0, revenue: 0, earnings: 0 };
    for (const b of ts.data?.buckets ?? []) {
      out.clicks += b.clicks;
      out.leads += b.leads;
      out.sales += b.sales;
      out.revenue += b.revenue;
      out.earnings += b.earnings;
    }
    return out;
  }, [ts.data]);

  return (
    <>
      <RangeSelector value={rangeDays} onChange={setRangeDays} />
      <ErrorBanner error={ts.error} />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12, marginBottom: 14 }}>
        <ChartCard title="Earnings" total={money(totals.earnings, 'USD')} buckets={ts.data?.buckets ?? []} field="earnings" loading={ts.isLoading} format="currency" />
        <ChartCard title="Clicks" total={totals.clicks.toLocaleString()} buckets={ts.data?.buckets ?? []} field="clicks" loading={ts.isLoading} format="count" />
        <ChartCard title="Leads" total={totals.leads.toLocaleString()} buckets={ts.data?.buckets ?? []} field="leads" loading={ts.isLoading} format="count" />
        <ChartCard title="Sales" total={totals.sales.toLocaleString()} buckets={ts.data?.buckets ?? []} field="sales" loading={ts.isLoading} format="count" />
      </div>

      <Card>
        <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 8 }}>Recent earnings</div>
        {recentCommissions.isLoading ? (
          <p style={{ color: theme.textMuted, fontSize: 12 }}>Loading…</p>
        ) : (recentCommissions.data?.commissions ?? []).length === 0 ? (
          <p style={{ color: theme.textMuted, fontSize: 12 }}>No earnings yet.</p>
        ) : (
          <CommissionsList rows={(recentCommissions.data?.commissions ?? []).slice(0, 10)} />
        )}
      </Card>
    </>
  );
}

// ---------- Earnings tab ----------

function EarningsTab() {
  const partnership = useOutletPartnership();
  const [rangeDays, setRangeDays] = useState<number>(30);
  const [statusFilter, setStatusFilter] = useState<'all' | 'accrued' | 'approved' | 'paid' | 'reversed'>('all');
  const since = useMemo(() => new Date(Date.now() - rangeDays * 24 * 60 * 60 * 1000).toISOString(), [rangeDays]);

  const ts = useQuery({
    queryKey: ['creator-program-timeseries', partnership.id, rangeDays],
    queryFn: () =>
      creatorApi<Timeseries>(`/creators/me/partnerships/${partnership.id}/timeseries?since=${encodeURIComponent(since)}`),
    retry: false,
    staleTime: 60_000,
  });

  const commissions = useQuery({
    queryKey: ['creator-program-commissions', partnership.id, statusFilter],
    queryFn: () =>
      creatorApi<{ commissions: CommissionRow[] }>(
        `/creators/me/partnerships/${partnership.id}/commissions${statusFilter !== 'all' ? `?status=${statusFilter}` : ''}`,
      ),
    retry: false,
    staleTime: 60_000,
  });

  const totalEarnings = useMemo(
    () => (ts.data?.buckets ?? []).reduce((sum, b) => sum + b.earnings, 0),
    [ts.data],
  );

  return (
    <>
      <RangeSelector value={rangeDays} onChange={setRangeDays} />
      <ErrorBanner error={ts.error ?? commissions.error} />
      <div style={{ marginBottom: 14 }}>
        <ChartCard
          title="Total earnings"
          total={money(totalEarnings, 'USD')}
          buckets={ts.data?.buckets ?? []}
          field="earnings"
          loading={ts.isLoading}
          format="currency"
          tall
        />
      </div>

      <Card>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 8 }}>
          <div style={{ fontSize: 13, fontWeight: 500, flex: 1 }}>Commissions</div>
          <FilterChips
            value={statusFilter}
            options={[
              { value: 'all', label: 'All' },
              { value: 'accrued', label: 'Accrued' },
              { value: 'approved', label: 'Approved' },
              { value: 'paid', label: 'Paid' },
              { value: 'reversed', label: 'Reversed' },
            ]}
            onChange={(v) => setStatusFilter(v as typeof statusFilter)}
          />
        </div>
        {commissions.isLoading ? (
          <p style={{ color: theme.textMuted, fontSize: 12 }}>Loading…</p>
        ) : (commissions.data?.commissions ?? []).length === 0 ? (
          <EmptyState title="No commissions" hint="Conversions will show up here once you start driving sales." />
        ) : (
          <CommissionsList rows={commissions.data?.commissions ?? []} />
        )}
      </Card>
    </>
  );
}

// ---------- Events tab ----------

function EventsTab() {
  const partnership = useOutletPartnership();
  const [typeFilter, setTypeFilter] = useState<string>('');
  const events = useQuery({
    queryKey: ['creator-program-events', partnership.id, typeFilter],
    queryFn: () =>
      creatorApi<{ events: PartnerEvent[] }>(
        `/creators/me/partnerships/${partnership.id}/events?limit=100${typeFilter ? `&type=${encodeURIComponent(typeFilter)}` : ''}`,
      ),
    retry: false,
    staleTime: 30_000,
  });

  // Pull the unique event types we've seen so the filter chips reflect
  // what's actually in the data — avoids hard-coding a list that
  // diverges from custom brand event taxonomies.
  const seenTypes = useMemo(() => {
    const set = new Set<string>();
    for (const e of events.data?.events ?? []) set.add(e.type);
    return Array.from(set).sort();
  }, [events.data]);

  return (
    <>
      <ErrorBanner error={events.error} />
      <Card>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 8 }}>
          <div style={{ fontSize: 13, fontWeight: 500, flex: 1 }}>Events</div>
          {seenTypes.length > 0 && (
            <FilterChips
              value={typeFilter}
              options={[{ value: '', label: 'All' }, ...seenTypes.map((t) => ({ value: t, label: t }))]}
              onChange={setTypeFilter}
            />
          )}
        </div>
        {events.isLoading ? (
          <p style={{ color: theme.textMuted, fontSize: 12 }}>Loading…</p>
        ) : (events.data?.events ?? []).length === 0 ? (
          <EmptyState
            title="No events recorded"
            hint="Events appear here when customers click your link or convert."
          />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <Row header>
              <span style={{ flex: 1 }}>Event</span>
              <span style={{ width: 100 }}>Value</span>
              <span style={{ width: 100 }}>Source</span>
              <span style={{ width: 140, textAlign: 'right' }}>When</span>
            </Row>
            {(events.data?.events ?? []).map((e) => (
              <Row key={e.attributionId}>
                <span style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <span style={{ fontSize: 13, color: theme.text }}>{e.type}</span>
                  <span style={{ fontSize: 11, color: theme.textDim, fontFamily: theme.fontMono }}>
                    user {shortId(e.userId)}
                  </span>
                </span>
                <span style={{ width: 100, fontSize: 13, color: e.value != null ? theme.text : theme.textDim }}>
                  {e.value != null ? money(e.value, e.currency ?? 'USD') : '—'}
                </span>
                <span style={{ width: 100, fontSize: 12, color: theme.textMuted }}>
                  {e.click?.linkKey ? `link · ${e.click.linkKey}` : 'coupon'}
                </span>
                <span style={{ width: 140, fontSize: 12, color: theme.textMuted, textAlign: 'right' }}>
                  {formatDate(e.ts, { relative: true })}
                </span>
              </Row>
            ))}
          </div>
        )}
      </Card>
    </>
  );
}

// ---------- Customers tab ----------

function CustomersTab() {
  const partnership = useOutletPartnership();
  const customers = useQuery({
    queryKey: ['creator-program-customers', partnership.id],
    queryFn: () => creatorApi<{ customers: Customer[] }>(`/creators/me/partnerships/${partnership.id}/customers?limit=100`),
    retry: false,
    staleTime: 60_000,
  });

  return (
    <>
      <ErrorBanner error={customers.error} />
      <Card>
        <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 8 }}>Customers</div>
        {customers.isLoading ? (
          <p style={{ color: theme.textMuted, fontSize: 12 }}>Loading…</p>
        ) : (customers.data?.customers ?? []).length === 0 ? (
          <EmptyState
            title="No customers yet"
            hint="Customers attributed to you through this program will appear here."
          />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <Row header>
              <span style={{ flex: 1 }}>Customer</span>
              <span style={{ width: 100, textAlign: 'right' }}>Events</span>
              <span style={{ width: 120, textAlign: 'right' }}>Revenue</span>
              <span style={{ width: 140, textAlign: 'right' }}>First seen</span>
            </Row>
            {(customers.data?.customers ?? []).map((c) => (
              <Row key={c.userId}>
                <span style={{ flex: 1, fontSize: 13, color: theme.text, fontFamily: theme.fontMono }}>
                  {shortId(c.userId, 12)}
                </span>
                <span style={{ width: 100, textAlign: 'right', fontSize: 13, color: theme.textMuted }}>
                  {c.eventCount.toLocaleString()}
                </span>
                <span style={{ width: 120, textAlign: 'right', fontSize: 13, color: theme.text }}>
                  {money(c.revenue, 'USD')}
                </span>
                <span style={{ width: 140, textAlign: 'right', fontSize: 12, color: theme.textMuted }}>
                  {formatDate(c.firstEventAt, { relative: true })}
                </span>
              </Row>
            ))}
          </div>
        )}
      </Card>
    </>
  );
}

// ---------- Analytics tab (referrer / UTM / country / device breakdowns) ----------

type BreakdownDimension =
  | 'referer'
  | 'utm_source'
  | 'utm_medium'
  | 'utm_campaign'
  | 'country'
  | 'device'
  | 'browser'
  | 'os';

interface Breakdown {
  dimension: BreakdownDimension;
  rows: Array<{ value: string; count: number }>;
  sampleSize?: number;
  sampleCapped?: boolean;
}

function AnalyticsTab() {
  const partnership = useOutletPartnership();
  const [rangeDays, setRangeDays] = useState<number>(30);

  return (
    <>
      <RangeSelector value={rangeDays} onChange={setRangeDays} />
      <p style={{ fontSize: 12, color: theme.textDim, margin: '0 0 14px' }}>
        Click breakdowns over the selected window. Rows are top-10 per dimension. Empty panels mean
        either no clicks recorded UTMs / referrer info, or the brand&rsquo;s router pre-dates UTM
        capture.
      </p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 12 }}>
        <BreakdownPanel partnershipId={partnership.id} dimension="referer" title="Referrers" rangeDays={rangeDays} />
        <BreakdownPanel partnershipId={partnership.id} dimension="country" title="Countries" rangeDays={rangeDays} formatter={countryFormatter} />
        <BreakdownPanel partnershipId={partnership.id} dimension="utm_source" title="UTM source" rangeDays={rangeDays} />
        <BreakdownPanel partnershipId={partnership.id} dimension="utm_medium" title="UTM medium" rangeDays={rangeDays} />
        <BreakdownPanel partnershipId={partnership.id} dimension="utm_campaign" title="UTM campaign" rangeDays={rangeDays} />
        <BreakdownPanel partnershipId={partnership.id} dimension="device" title="Devices" rangeDays={rangeDays} />
        <BreakdownPanel partnershipId={partnership.id} dimension="browser" title="Browsers" rangeDays={rangeDays} />
        <BreakdownPanel partnershipId={partnership.id} dimension="os" title="Operating systems" rangeDays={rangeDays} />
      </div>
    </>
  );
}

function BreakdownPanel({
  partnershipId,
  dimension,
  title,
  rangeDays,
  formatter,
}: {
  partnershipId: string;
  dimension: BreakdownDimension;
  title: string;
  rangeDays: number;
  formatter?: (value: string) => string;
}) {
  const since = useMemo(() => new Date(Date.now() - rangeDays * 24 * 60 * 60 * 1000).toISOString(), [rangeDays]);
  const q = useQuery({
    queryKey: ['creator-program-breakdown', partnershipId, dimension, rangeDays],
    queryFn: () =>
      creatorApi<Breakdown>(
        `/creators/me/partnerships/${partnershipId}/breakdowns?dimension=${dimension}&since=${encodeURIComponent(since)}`,
      ),
    retry: false,
    staleTime: 60_000,
  });

  const total = useMemo(
    () => (q.data?.rows ?? []).reduce((sum, r) => sum + r.count, 0),
    [q.data],
  );

  return (
    <Card>
      <div style={{ fontSize: 11, color: theme.textDim, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>
        {title}
      </div>
      {q.isLoading ? (
        <p style={{ color: theme.textMuted, fontSize: 12, margin: 0 }}>Loading…</p>
      ) : (q.data?.rows ?? []).length === 0 ? (
        <p style={{ color: theme.textDim, fontSize: 12, margin: 0 }}>No data</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {(q.data?.rows ?? []).map((r) => {
            const pct = total > 0 ? (r.count / total) * 100 : 0;
            return (
              <div key={r.value} style={{ position: 'relative' }}>
                <div
                  style={{
                    position: 'absolute',
                    inset: 0,
                    background: theme.accent,
                    opacity: 0.08,
                    borderRadius: 4,
                    width: `${Math.max(2, pct)}%`,
                  }}
                />
                <div style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 8, padding: '4px 6px', fontSize: 12 }}>
                  <span style={{ flex: 1, color: theme.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {formatter ? formatter(r.value) : r.value}
                  </span>
                  <span style={{ color: theme.textMuted, fontVariantNumeric: 'tabular-nums' }}>
                    {r.count.toLocaleString()}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}
      {q.data?.sampleCapped && (
        <p style={{ fontSize: 10, color: theme.textDim, marginTop: 6, marginBottom: 0 }}>
          Sampled most-recent {q.data.sampleSize?.toLocaleString()} clicks for parsing.
        </p>
      )}
    </Card>
  );
}

/** ISO 3166-1 alpha-2 → uppercase + flag emoji. Cheap inline display
 *  formatter; we don't have a country-name lookup table on the client. */
function countryFormatter(code: string): string {
  if (!code || code.length !== 2) return code || 'unknown';
  const upper = code.toUpperCase();
  // Regional indicator symbols: 'A' + 0x1F1E6 - 'A'.charCodeAt(0)
  const flag = upper
    .split('')
    .map((c) => String.fromCodePoint(0x1f1e6 + c.charCodeAt(0) - 65))
    .join('');
  return `${flag} ${upper}`;
}

// ---------- Resources tab ----------
//
// Brand-provided marketing kit: color hex (with copy), logo, downloadable
// images, and copy snippets the creator can paste verbatim. All federated
// from the vendor — empty when the brand hasn't uploaded anything yet.

function ResourcesTab() {
  const partnership = useOutletPartnership();
  const info = useBrandInfo(partnership.id);

  if (info.isLoading) return <Card>Loading…</Card>;

  const brand = info.data?.brand;
  const assets = info.data?.assets ?? [];
  const images = assets.filter((a) => a.kind === 'image' && a.url);
  const snippets = assets.filter((a) => a.kind === 'snippet' && a.body);

  const hasAnything =
    !!brand?.brandColor || !!brand?.logoUrl || images.length > 0 || snippets.length > 0;

  if (!hasAnything) {
    return (
      <Card>
        <p style={{ color: theme.textMuted, fontSize: 13, margin: 0 }}>
          {partnership.vendorName} hasn&rsquo;t shared brand resources yet. Email them at{' '}
          {brand?.supportEmail ? (
            <a href={`mailto:${brand.supportEmail}`} style={{ color: theme.accent }}>
              {brand.supportEmail}
            </a>
          ) : (
            'their support address'
          )}{' '}
          to request logos or copy snippets.
        </p>
      </Card>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {(brand?.brandColor || brand?.logoUrl) && (
        <BrandKitCard
          brandColor={brand?.brandColor ?? null}
          logoUrl={brand?.logoUrl ?? null}
          displayName={brand?.displayName ?? partnership.vendorName}
        />
      )}
      {images.length > 0 && (
        <Card>
          <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 10 }}>Images</div>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
              gap: 10,
            }}
          >
            {images.map((a) => (
              <ImageAssetCard key={a.id} asset={a} />
            ))}
          </div>
        </Card>
      )}
      {snippets.length > 0 && (
        <Card>
          <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 10 }}>Copy snippets</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {snippets.map((a) => (
              <SnippetCard key={a.id} asset={a} />
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}

function BrandKitCard({
  brandColor,
  logoUrl,
  displayName,
}: {
  brandColor: string | null;
  logoUrl: string | null;
  displayName: string;
}) {
  return (
    <Card>
      <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 10 }}>Brand kit</div>
      <div style={{ display: 'flex', gap: 18, alignItems: 'center', flexWrap: 'wrap' }}>
        {logoUrl && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <img
              src={logoUrl}
              alt={`${displayName} logo`}
              style={{
                width: 80,
                height: 80,
                objectFit: 'contain',
                background: theme.surface2,
                border: `1px solid ${theme.borderSubtle}`,
                borderRadius: theme.radiusSm,
                padding: 8,
              }}
            />
            <a
              href={logoUrl}
              download
              target="_blank"
              rel="noreferrer noopener"
              style={{ fontSize: 11, color: theme.accent, textAlign: 'center', textDecoration: 'none' }}
            >
              Download
            </a>
          </div>
        )}
        {brandColor && <ColorChip color={brandColor} />}
      </div>
    </Card>
  );
}

function ColorChip({ color }: { color: string }) {
  const [copied, setCopied] = useState(false);
  function copy() {
    navigator.clipboard.writeText(color).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => {/* ignore */},
    );
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-start' }}>
      <button
        onClick={copy}
        title="Copy color"
        style={{
          width: 80,
          height: 80,
          borderRadius: theme.radiusSm,
          background: color,
          border: `1px solid ${theme.borderSubtle}`,
          cursor: 'pointer',
        }}
      />
      <code
        onClick={copy}
        style={{
          fontSize: 12,
          fontFamily: theme.fontMono,
          color: copied ? theme.success : theme.textMuted,
          cursor: 'pointer',
        }}
      >
        {copied ? 'Copied' : color}
      </code>
    </div>
  );
}

function ImageAssetCard({ asset }: { asset: BrandAsset }) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        background: theme.surface2,
        border: `1px solid ${theme.borderSubtle}`,
        borderRadius: theme.radiusSm,
        padding: 10,
      }}
    >
      <a href={asset.url ?? '#'} target="_blank" rel="noreferrer noopener">
        <img
          src={asset.url ?? ''}
          alt={asset.label}
          style={{
            width: '100%',
            height: 140,
            objectFit: 'contain',
            background: theme.bg,
            borderRadius: 4,
          }}
        />
      </a>
      <div style={{ fontSize: 12, fontWeight: 500 }}>{asset.label}</div>
      {asset.description && (
        <div style={{ fontSize: 11, color: theme.textMuted }}>{asset.description}</div>
      )}
      <a
        href={asset.url ?? '#'}
        download
        target="_blank"
        rel="noreferrer noopener"
        style={{ fontSize: 11, color: theme.accent, textDecoration: 'none' }}
      >
        Download
      </a>
    </div>
  );
}

function SnippetCard({ asset }: { asset: BrandAsset }) {
  const [copied, setCopied] = useState(false);
  function copy() {
    navigator.clipboard.writeText(asset.body ?? '').then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => {/* ignore */},
    );
  }
  return (
    <div
      style={{
        background: theme.surface2,
        border: `1px solid ${theme.borderSubtle}`,
        borderRadius: theme.radiusSm,
        padding: 12,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 6 }}>
        <div style={{ fontSize: 12, fontWeight: 500, flex: 1 }}>{asset.label}</div>
        <button
          onClick={copy}
          style={{
            background: 'transparent',
            border: `1px solid ${theme.borderSubtle}`,
            borderRadius: 6,
            padding: '4px 10px',
            fontSize: 11,
            color: copied ? theme.success : theme.textMuted,
            cursor: 'pointer',
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      {asset.description && (
        <div style={{ fontSize: 11, color: theme.textMuted, marginBottom: 6 }}>
          {asset.description}
        </div>
      )}
      <div
        style={{
          fontSize: 13,
          color: theme.text,
          fontFamily: theme.fontMono,
          whiteSpace: 'pre-wrap',
          background: theme.bg,
          border: `1px solid ${theme.borderSubtle}`,
          borderRadius: 4,
          padding: 10,
        }}
      >
        {asset.body}
      </div>
    </div>
  );
}

// ---------- Shared components ----------

function RangeSelector({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <div style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
      {RANGE_OPTIONS.map((r) => (
        <button
          key={r.days}
          onClick={() => onChange(r.days)}
          style={{
            padding: '5px 10px',
            background: value === r.days ? theme.surface : 'transparent',
            border: `1px solid ${value === r.days ? theme.border : theme.borderSubtle}`,
            borderRadius: 6,
            color: value === r.days ? theme.text : theme.textMuted,
            fontSize: 12,
            cursor: 'pointer',
          }}
        >
          {r.label}
        </button>
      ))}
    </div>
  );
}

function FilterChips<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (v: T) => void;
}) {
  return (
    <div style={{ display: 'flex', gap: 4 }}>
      {options.map((o) => (
        <button
          key={o.value || 'all'}
          onClick={() => onChange(o.value)}
          style={{
            padding: '4px 10px',
            background: value === o.value ? theme.surface : 'transparent',
            border: `1px solid ${value === o.value ? theme.border : theme.borderSubtle}`,
            borderRadius: 999,
            color: value === o.value ? theme.text : theme.textMuted,
            fontSize: 11,
            cursor: 'pointer',
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Row({ children, header }: { children: ReactNode; header?: boolean }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '10px 4px',
        borderBottom: `1px solid ${theme.borderSubtle}`,
        fontSize: header ? 11 : 13,
        color: header ? theme.textDim : theme.text,
        textTransform: header ? 'uppercase' : 'none',
        letterSpacing: header ? '0.05em' : 'normal',
      }}
    >
      {children}
    </div>
  );
}

/** Sparkline-style chart card. SVG-based so we don't pull in a chart
 *  dep just for partner-facing metric blocks; the pixel cost is one
 *  polyline + an area fill per card. Width auto-scales to the parent
 *  via viewBox + preserveAspectRatio. */
function ChartCard({
  title,
  total,
  buckets,
  field,
  loading,
  format,
  tall,
}: {
  title: string;
  total: string;
  buckets: TimeseriesBucket[];
  field: 'clicks' | 'leads' | 'sales' | 'revenue' | 'earnings';
  loading: boolean;
  format: 'count' | 'currency';
  tall?: boolean;
}) {
  const values = buckets.map((b) => b[field]);
  const max = Math.max(1, ...values);
  const w = 600;
  const h = tall ? 140 : 60;
  const points = values.map((v, i) => {
    const x = values.length > 1 ? (i / (values.length - 1)) * w : 0;
    const y = h - (v / max) * h;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const polyline = points.join(' ');
  const areaPath = points.length > 0
    ? `M0,${h} L${polyline.split(' ').join(' L')} L${w},${h} Z`
    : '';

  return (
    <Card>
      <div style={{ fontSize: 11, color: theme.textDim, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>
        {title}
      </div>
      <div style={{ fontSize: tall ? 24 : 18, fontWeight: 500, marginBottom: 8 }}>
        {loading ? '—' : total}
      </div>
      {values.some((v) => v > 0) ? (
        <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ width: '100%', height: tall ? 120 : 50, display: 'block' }}>
          {areaPath && <path d={areaPath} fill={theme.accent} fillOpacity="0.12" />}
          <polyline
            points={polyline}
            fill="none"
            stroke={theme.accent}
            strokeWidth={tall ? 2 : 1.5}
            strokeLinejoin="round"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      ) : (
        <div style={{ height: tall ? 120 : 50, display: 'flex', alignItems: 'center', justifyContent: 'center', color: theme.textDim, fontSize: 11 }}>
          No data {tall ? 'in range' : ''}
        </div>
      )}
      {format === 'currency' && values.some((v) => v > 0) && (
        <div style={{ fontSize: 10, color: theme.textDim, marginTop: 4 }}>peak {money(max, 'USD')}</div>
      )}
    </Card>
  );
}

function CommissionsList({ rows }: { rows: CommissionRow[] }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      <Row header>
        <span style={{ flex: 1 }}>Commission</span>
        <span style={{ width: 90 }}>Status</span>
        <span style={{ width: 100, textAlign: 'right' }}>Amount</span>
        <span style={{ width: 140, textAlign: 'right' }}>Accrued</span>
      </Row>
      {rows.map((c) => (
        <Row key={c.id}>
          <span style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span style={{ fontSize: 13, color: theme.text }}>{c.campaignName ?? 'Commission'}</span>
            {c.matureAt && c.status === 'accrued' && (
              <span style={{ fontSize: 11, color: theme.textDim }}>
                Matures {formatDate(c.matureAt, { relative: true })}
              </span>
            )}
          </span>
          <span style={{ width: 90, fontSize: 11, color: theme.textMuted, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
            {c.status}
          </span>
          <span style={{ width: 100, textAlign: 'right', fontSize: 13, color: theme.text }}>
            {money(c.amount, c.currency ?? 'USD')}
          </span>
          <span style={{ width: 140, textAlign: 'right', fontSize: 12, color: theme.textMuted }}>
            {formatDate(c.accruedAt, { relative: true })}
          </span>
        </Row>
      ))}
    </div>
  );
}
