import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { CheckCircle2, Circle, Globe, HelpCircle } from 'lucide-react';
import { Button, Card, EmptyState, ErrorBanner, Input, Label, Page, Select } from '../../ui.js';
import { theme } from '../../theme.js';
import { creatorApi } from './creator-api.js';
import {
  renderCommissionSummary,
  type CommissionSubRuleLike,
  type CustomerRewardLike,
} from '../../lib/commission-summary.js';

type MyStatus = 'none' | 'pending' | 'approved' | 'rejected' | 'cancelled';
type AttributionModel = 'last_click' | 'first_click' | 'linear' | 'position';

interface OfferingTerms {
  commissionDescription?: string;
  cookieWindowDays?: number;
  payoutCadence?: string;
  payoutHoldbackDays?: number;
  attributionWindowDays?: number;
  attributionModel?: AttributionModel;
  /** Legacy single-rule mirror — still surfaced for older offerings
   *  whose Network row predates the compound-rules refactor. */
  commissionType?: 'percent' | 'fixed';
  commissionValue?: number;
  recurring?: boolean;
  /** Compound rule snapshot. Preferred — when present we re-derive the
   *  display summary client-side so even an offering whose Network
   *  commissionDescription wasn't re-stamped renders rule-faithfully. */
  commissionRules?: CommissionSubRuleLike[];
  /** Customer-side reward. Drives the "Dual reward" chip + extends the
   *  derived summary with "customers get …". */
  customerReward?: CustomerRewardLike | null;
  /** ISO timestamp when the bound vendor Campaign expires. Null =
   *  indefinite (no end date). Absent = legacy offering created
   *  before the snapshot was added — duration UI omits the chip
   *  rather than guessing. */
  campaignEndsAt?: string | null;
}

interface OfferingListItem {
  id: string;
  title: string;
  description: string | null;
  productUrl: string;
  vendorId: string;
  vendorName: string;
  vendorLogoUrl: string | null;
  vendorPartnerCount: number;
  terms: OfferingTerms;
  createdAt: string;
  myStatus: MyStatus;
}

const MODEL_LABELS: Record<AttributionModel, string> = {
  last_click: 'Last click',
  first_click: 'First click',
  linear: 'Linear',
  position: 'Position',
};

/** Days between now and `endsAt`, rounded up. Returns null when the
 *  field is unknown (legacy offering) or explicitly null (indefinite)
 *  — both qualify for any "min remaining" filter since they're at least
 *  as long as any bounded program. Returns 0 for already-ended (which
 *  shouldn't appear in the listing but defensively guards the UI). */
function daysRemaining(endsAt: string | null | undefined): number | null {
  if (endsAt === undefined || endsAt === null) return null;
  const end = new Date(endsAt);
  if (Number.isNaN(end.getTime())) return null;
  const ms = end.getTime() - Date.now();
  if (ms <= 0) return 0;
  return Math.ceil(ms / (24 * 60 * 60 * 1000));
}

/** Render-ready chip describing the program's runway. Returns null
 *  for unknown (no chip — don't lie about Ongoing). `kind: 'soon'`
 *  bumps the chip to accent tone so a 12-day window pops vs a 6-month
 *  one. */
function formatDuration(
  endsAt: string | null | undefined,
): { label: string; kind: 'ongoing' | 'soon' | 'date' } | null {
  if (endsAt === undefined) return null;
  if (endsAt === null) return { label: 'Ongoing', kind: 'ongoing' };
  const end = new Date(endsAt);
  if (Number.isNaN(end.getTime())) return null;
  const days = daysRemaining(endsAt);
  if (days === null || days <= 0) return null;
  if (days <= 14) return { label: `Ends in ${days}d`, kind: 'soon' };
  if (days <= 60) return { label: `Ends in ${days}d`, kind: 'date' };
  // For longer windows show the actual date — "Ends in 184d" is harder
  // to picture than "Ends Sep 12".
  const now = new Date();
  const fmt = end.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(end.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}),
  });
  return { label: `Ends ${fmt}`, kind: 'date' };
}

export function CreatorDiscoverPage() {
  const [q, setQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [sort, setSort] = useState<'newest' | 'popular'>('newest');

  // Filter state. All filter-by-* defaults to 'any' so the grid renders
  // the full result set on first load. Client-side filter — the network
  // /offerings endpoint stays simple, and the dataset is small enough at
  // launch (a few hundred offerings) that filtering in the browser is
  // imperceptible. Move to server-side when we cross ~1k.
  const [model, setModel] = useState<'any' | AttributionModel>('any');
  const [maxHoldback, setMaxHoldback] = useState<'any' | '0' | '14' | '30' | '60' | '90'>('any');
  const [minWindow, setMinWindow] = useState<'any' | '30' | '60' | '90'>('any');
  const [recurringOnly, setRecurringOnly] = useState(false);
  const [minCommission, setMinCommission] = useState<'any' | '10' | '20' | '30'>('any');
  // Min remaining runway on the program. Indefinite (no end date) and
  // unknown (legacy offerings without a snapshot) always qualify —
  // they're at least as long as any bounded program, so excluding them
  // would over-hide.
  const [minDuration, setMinDuration] = useState<'any' | '30' | '90' | '365'>('any');
  // Filters open by default — they're the main way creators narrow the
  // grid, and an unopened panel hid the most useful affordance behind a
  // click. Toggle still collapses for users who want a denser view.
  const [showFilters, setShowFilters] = useState(true);

  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedQ(q.trim()), 250);
    return () => window.clearTimeout(t);
  }, [q]);

  const params = new URLSearchParams();
  if (debouncedQ) params.set('q', debouncedQ);
  if (sort !== 'newest') params.set('sort', sort);
  const qs = params.toString();

  const { data, isLoading, error } = useQuery({
    queryKey: ['creator-discover', debouncedQ, sort],
    queryFn: () => creatorApi<{ offerings: OfferingListItem[] }>(`/offerings${qs ? '?' + qs : ''}`),
    retry: false,
  });

  const filtered = useMemo(() => {
    if (!data) return [];
    return data.offerings.filter((o) => {
      const t = o.terms ?? {};
      if (model !== 'any' && t.attributionModel !== model) return false;
      if (maxHoldback !== 'any') {
        const cap = Number(maxHoldback);
        const h = t.payoutHoldbackDays ?? 0;
        if (h > cap) return false;
      }
      if (minWindow !== 'any') {
        const min = Number(minWindow);
        const w = t.attributionWindowDays ?? 0;
        if (w < min) return false;
      }
      if (recurringOnly && !t.recurring) return false;
      if (minCommission !== 'any') {
        const min = Number(minCommission);
        // Only filter by commission % when the offering explicitly
        // exposes a percent rule. Fixed-fee offerings stay visible
        // (they're a different shape; filtering them out would over-
        // hide).
        if (t.commissionType === 'percent' && (t.commissionValue ?? 0) < min) return false;
      }
      if (minDuration !== 'any') {
        const min = Number(minDuration);
        const remaining = daysRemaining(t.campaignEndsAt);
        // null = indefinite OR unknown — always qualifies (longest
        // possible runway). Bounded programs only qualify when their
        // remaining days clear the threshold.
        if (remaining !== null && remaining < min) return false;
      }
      return true;
    });
  }, [data, model, maxHoldback, minWindow, recurringOnly, minCommission, minDuration]);

  const activeFilterCount =
    (model !== 'any' ? 1 : 0) +
    (maxHoldback !== 'any' ? 1 : 0) +
    (minWindow !== 'any' ? 1 : 0) +
    (recurringOnly ? 1 : 0) +
    (minCommission !== 'any' ? 1 : 0) +
    (minDuration !== 'any' ? 1 : 0);

  function clearFilters() {
    setModel('any');
    setMaxHoldback('any');
    setMinWindow('any');
    setRecurringOnly(false);
    setMinCommission('any');
    setMinDuration('any');
  }

  return (
    <Page title="Discover programs" subtitle="Partner programs across the OpenPartner Network. Apply to any.">
      <ErrorBanner error={error} />
      <CreatorOnboarding />
      <RecommendedStrip />
      <Card>
        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 240 }}>
            <Label>Search</Label>
            <Input placeholder="Title or description…" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <div style={{ minWidth: 160 }}>
            <Label>Sort</Label>
            <Select value={sort} onChange={(e) => setSort(e.target.value as 'newest' | 'popular')}>
              <option value="newest">Newest</option>
              <option value="popular">Most partners</option>
            </Select>
          </div>
          <button
            type="button"
            onClick={() => setShowFilters((s) => !s)}
            style={{
              background: showFilters ? `${theme.accent}15` : 'transparent',
              border: `1px solid ${showFilters ? theme.accent : theme.border}`,
              borderRadius: theme.radiusSm,
              color: showFilters ? theme.accent : theme.text,
              cursor: 'pointer',
              padding: '9px 14px',
              fontSize: 13,
              fontWeight: 500,
              whiteSpace: 'nowrap',
            }}
          >
            Filters{activeFilterCount > 0 ? ` · ${activeFilterCount}` : ''}
          </button>
        </div>
        {showFilters && (
          <div
            style={{
              marginTop: 14,
              paddingTop: 14,
              borderTop: `1px solid ${theme.borderSubtle}`,
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
              gap: 12,
            }}
          >
            <div>
              <LabelWithHelp
                label="Attribution model"
                hint="How the brand splits credit when a customer touches several creator links before converting. Last click pays the most recent referrer; first click pays the discoverer; linear/position split across all touches."
              />
              <Select value={model} onChange={(e) => setModel(e.target.value as typeof model)}>
                <option value="any">Any</option>
                <option value="last_click">Last click</option>
                <option value="first_click">First click</option>
                <option value="linear">Linear</option>
                <option value="position">Position</option>
              </Select>
            </div>
            <div>
              <LabelWithHelp
                label="Min attribution window"
                hint="The longest gap between someone's click on your link and their eventual purchase that still pays you. Bigger window = more conversions credited to you, especially for products with long evaluation cycles."
              />
              <Select value={minWindow} onChange={(e) => setMinWindow(e.target.value as typeof minWindow)}>
                <option value="any">Any</option>
                <option value="30">≥ 30 days</option>
                <option value="60">≥ 60 days</option>
                <option value="90">≥ 90 days</option>
              </Select>
            </div>
            <div>
              <LabelWithHelp
                label="Max payout holdback"
                hint="Time after a customer converts before the brand can approve + pay your commission. Aligns with their refund window or trial — shorter holdback = faster cash, but expect some clawbacks if customers cancel."
              />
              <Select value={maxHoldback} onChange={(e) => setMaxHoldback(e.target.value as typeof maxHoldback)}>
                <option value="any">Any</option>
                <option value="0">No holdback</option>
                <option value="14">≤ 14 days</option>
                <option value="30">≤ 30 days</option>
                <option value="60">≤ 60 days</option>
                <option value="90">≤ 90 days</option>
              </Select>
            </div>
            <div>
              <LabelWithHelp
                label="Min commission"
                hint="Lower bound on the percent-of-sale commission. Filters by the program's stated rate — fixed-fee programs (e.g. $50 per signup) stay visible regardless, since percent thresholds don't apply to them."
              />
              <Select value={minCommission} onChange={(e) => setMinCommission(e.target.value as typeof minCommission)}>
                <option value="any">Any</option>
                <option value="10">≥ 10%</option>
                <option value="20">≥ 20%</option>
                <option value="30">≥ 30%</option>
              </Select>
            </div>
            <div>
              <LabelWithHelp
                label="Min remaining duration"
                hint="How long the program is guaranteed to keep accepting your conversions. Indefinite programs (no end date set) always qualify — they're the longest possible runway. Useful when you're investing time in a piece of content and want it to keep paying you."
              />
              <Select value={minDuration} onChange={(e) => setMinDuration(e.target.value as typeof minDuration)}>
                <option value="any">Any</option>
                <option value="30">≥ 30 days</option>
                <option value="90">≥ 90 days</option>
                <option value="365">≥ 1 year</option>
              </Select>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', paddingBottom: 2 }}>
              <Label>&nbsp;</Label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: theme.text, padding: '9px 0' }}>
                <input type="checkbox" checked={recurringOnly} onChange={(e) => setRecurringOnly(e.target.checked)} />
                Recurring only
                <HelpIcon hint="Show only programs that pay commission on every renewal of a subscription, not just the first invoice. Best for SaaS / membership products where the customer keeps paying month after month." />
              </label>
            </div>
            {activeFilterCount > 0 && (
              <div style={{ display: 'flex', alignItems: 'flex-end', paddingBottom: 9 }}>
                <button
                  type="button"
                  onClick={clearFilters}
                  style={{ background: 'transparent', border: 'none', color: theme.accent, cursor: 'pointer', fontSize: 13, padding: 0 }}
                >
                  Clear all
                </button>
              </div>
            )}
          </div>
        )}
      </Card>
      <div style={{ height: 18 }} />
      {isLoading ? (
        <Card>Loading…</Card>
      ) : filtered.length === 0 ? (
        <EmptyState
          title={
            debouncedQ
              ? `No matches for "${debouncedQ}"`
              : activeFilterCount > 0
                ? 'No programs match your filters'
                : 'No programs yet'
          }
          hint={
            activeFilterCount > 0
              ? 'Try widening one of the filters above.'
              : debouncedQ
                ? 'Try a different keyword.'
                : 'Vendors are joining all the time — check back soon.'
          }
          icon={<Globe size={28} strokeWidth={1.25} />}
        />
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 16 }}>
          {filtered.map((o) => (
            <OfferingDiscoverCard key={o.id} offering={o} />
          ))}
        </div>
      )}
    </Page>
  );
}

/**
 * Dub-style marketplace card.
 *
 * Layout (top → bottom): logo + brand name → description (line-clamp-3)
 * → chip strip with derived commission summary as the lead chip
 * → CTA pinned to the bottom of a fixed-height card so the grid lines
 * up regardless of how long any one description is.
 *
 * The full description lives on the offering detail page — only the
 * card truncates. Per-card height = 280px to fit ~3 lines of description
 * + chips + CTA without internal scroll on standard zooms.
 */
function OfferingDiscoverCard({ offering: o }: { offering: OfferingListItem }) {
  // Derive client-side from the rule snapshot when available so the
  // commission line is always rule-faithful even for offerings whose
  // Network row predates the May 2026 refactor. Falls back to whatever
  // the Network has stored.
  const commissionLine = o.terms.commissionRules
    ? renderCommissionSummary(o.terms.commissionRules, o.terms.customerReward)
    : o.terms.commissionDescription ?? null;
  const hasDualReward = o.terms.customerReward != null;

  return (
    <Card
      style={{
        display: 'flex',
        flexDirection: 'column',
        minHeight: 280,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
        <BrandMark logoUrl={o.vendorLogoUrl} name={o.vendorName} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <Link
            to={`/creator/vendors/${o.vendorId}`}
            style={{
              color: theme.text,
              fontSize: 15,
              fontWeight: 600,
              display: 'block',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {o.vendorName}
          </Link>
          {o.vendorPartnerCount > 0 && (
            <div style={{ color: theme.textDim, fontSize: 11 }}>
              {o.vendorPartnerCount} partner{o.vendorPartnerCount === 1 ? '' : 's'}
            </div>
          )}
        </div>
      </div>

      {o.description && (
        <Link
          to={`/creator/offerings/${o.id}`}
          style={{
            color: theme.textMuted,
            fontSize: 13,
            lineHeight: 1.45,
            display: '-webkit-box',
            WebkitLineClamp: 3,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
            marginBottom: 12,
            textDecoration: 'none',
          }}
          title={o.description}
        >
          {o.description}
        </Link>
      )}

      <div style={{ flex: 1 }} />

      <OfferingChips
        terms={o.terms}
        commissionLine={commissionLine}
        hasDualReward={hasDualReward}
      />

      <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 10 }}>
        <Link to={`/creator/offerings/${o.id}`}>
          <Button variant={o.myStatus === 'approved' || o.myStatus === 'pending' ? 'secondary' : 'primary'}>
            {ctaForStatus(o.myStatus)}
          </Button>
        </Link>
        {o.myStatus !== 'none' && o.myStatus !== 'rejected' && (
          <span style={{ fontSize: 12, color: o.myStatus === 'approved' ? theme.success : theme.textMuted }}>
            {o.myStatus === 'approved' ? '✓ Active' : o.myStatus === 'pending' ? 'Awaiting brand review' : null}
          </span>
        )}
      </div>
    </Card>
  );
}

/** 28×28 brand mark next to the vendor name on a discover card.
 *  Uses Tenant.logoUrl when the brand has uploaded one (mirrored from
 *  openpartner via the heartbeat); falls back to a colored letter
 *  chip so cards don't look skeletal for brands that haven't set a
 *  logo. */
function BrandMark({ logoUrl, name }: { logoUrl: string | null; name: string }) {
  const initial = name.charAt(0).toUpperCase() || '?';
  return (
    <div
      style={{
        width: 28,
        height: 28,
        borderRadius: 6,
        background: logoUrl ? theme.surface2 : theme.accent,
        color: theme.accentInk,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontWeight: 700,
        fontSize: 12,
        overflow: 'hidden',
        flexShrink: 0,
        border: `1px solid ${theme.borderSubtle}`,
      }}
    >
      {logoUrl ? (
        <img src={logoUrl} alt={name} style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
      ) : (
        initial
      )}
    </div>
  );
}

/** Filter label with a hover-help icon that explains the dimension.
 *  Creators picking filters often don't know what "attribution window"
 *  or "holdback" mean in concrete terms — the inline ? avoids forcing
 *  them out to docs. Tooltip uses native title for zero JS cost. */
function LabelWithHelp({ label, hint }: { label: string; hint: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 6 }}>
      <span style={{ fontSize: 12, color: theme.textMuted, fontWeight: 500 }}>{label}</span>
      <HelpIcon hint={hint} />
    </div>
  );
}

function HelpIcon({ hint }: { hint: string }) {
  return (
    <span
      title={hint}
      aria-label={hint}
      style={{ display: 'inline-flex', color: theme.textDim, cursor: 'help' }}
    >
      <HelpCircle size={13} strokeWidth={1.75} />
    </span>
  );
}

/** Tiny label-on-top row used inside a discover card. Replaces the
 *  former unlabeled paragraph text — creators should never see "50%"
 *  or a free-form description floating without context. `emphasize`
 *  bumps the value typography for the headline commission line. */
function CardField({ label, value, emphasize }: { label: string; value: string; emphasize?: boolean }) {
  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ fontSize: 10, color: theme.textDim, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase' }}>
        {label}
      </div>
      <div
        style={{
          fontSize: emphasize ? 14 : 13,
          color: emphasize ? theme.text : theme.textMuted,
          fontWeight: emphasize ? 500 : 400,
          marginTop: 2,
          lineHeight: 1.4,
        }}
      >
        {value}
      </div>
    </div>
  );
}

/** Chip row at the bottom of a discover card. Lead chip is the rule-derived
 *  commission line (rendered prominently); secondary chips are the
 *  filterable dimensions so the grid stays self-explanatory and matches
 *  the filter values above. Recurring + Dual reward + Ending-soon get
 *  accent tone so they pop against the muted secondary chips.
 *
 *  Caller passes commissionLine (vs. reading from terms) so we can derive
 *  client-side from the rule snapshot when present, while still falling back
 *  to whatever the Network stored.
 */
function OfferingChips({
  terms,
  commissionLine,
  hasDualReward,
}: {
  terms: OfferingTerms;
  commissionLine?: string | null;
  hasDualReward?: boolean;
}) {
  const chips: Array<{ label: string; tone?: 'accent' | 'muted' | 'lead' }> = [];
  if (commissionLine) chips.push({ label: commissionLine, tone: 'lead' });
  if (hasDualReward) chips.push({ label: 'Dual reward', tone: 'accent' });
  if (terms.attributionModel) chips.push({ label: MODEL_LABELS[terms.attributionModel], tone: 'muted' });
  if (terms.attributionWindowDays) chips.push({ label: `${terms.attributionWindowDays}d window`, tone: 'muted' });
  if (terms.cookieWindowDays) chips.push({ label: `${terms.cookieWindowDays}d cookie`, tone: 'muted' });
  if (terms.payoutHoldbackDays != null && terms.payoutHoldbackDays > 0) {
    chips.push({ label: `${terms.payoutHoldbackDays}d holdback`, tone: 'muted' });
  }
  if (terms.payoutCadence) chips.push({ label: `${terms.payoutCadence} payouts`, tone: 'muted' });
  const duration = formatDuration(terms.campaignEndsAt);
  if (duration) chips.push({ label: duration.label, tone: duration.kind === 'soon' ? 'accent' : 'muted' });
  if (chips.length === 0) return null;
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
      {chips.map((c, i) => {
        const isLead = c.tone === 'lead';
        const isAccent = c.tone === 'accent';
        return (
          <span
            key={i}
            style={{
              fontSize: isLead ? 12 : 11,
              fontWeight: isLead ? 600 : 500,
              padding: isLead ? '4px 10px' : '3px 8px',
              borderRadius: 999,
              background: isLead || isAccent ? `${theme.accent}15` : theme.surface2,
              color: isLead || isAccent ? theme.accent : theme.textMuted,
              border: `1px solid ${isLead || isAccent ? `${theme.accent}55` : theme.borderSubtle}`,
              whiteSpace: isLead ? 'normal' : 'nowrap',
              maxWidth: '100%',
            }}
          >
            {c.label}
          </span>
        );
      })}
    </div>
  );
}

interface Recommendation {
  id: string;
  title: string;
  description: string | null;
  vendorId: string;
  vendorName: string;
  terms: { commissionDescription?: string; payoutHoldbackDays?: number };
  reasons: string[];
}

/** "Recommended for you" strip above the open Discover grid. Lifts
 *  application volume for creators who don't browse. Hidden when the
 *  recommender has nothing to show — better than padding with noise. */
function RecommendedStrip() {
  const { data, isLoading } = useQuery({
    queryKey: ['creator-recommendations'],
    queryFn: () => creatorApi<{ recommendations: Recommendation[] }>('/creators/me/recommendations'),
    retry: false,
    staleTime: 5 * 60_000,
  });

  if (isLoading || !data || data.recommendations.length === 0) return null;

  return (
    <Card style={{ marginBottom: 18 }}>
      <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 4 }}>Recommended for you</div>
      <p style={{ fontSize: 13, color: theme.textMuted, margin: '0 0 14px' }}>
        Programs that match your profile, ranked by category overlap + commission richness.
      </p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 10 }}>
        {data.recommendations.map((r) => (
          <Link
            key={r.id}
            to={`/creator/offerings/${r.id}`}
            style={{
              textDecoration: 'none',
              padding: '12px 14px',
              background: theme.surface2,
              border: `1px solid ${theme.borderSubtle}`,
              borderRadius: theme.radiusSm,
              color: theme.text,
              display: 'flex',
              flexDirection: 'column',
              gap: 4,
            }}
          >
            <div style={{ fontSize: 11, color: theme.textMuted }}>{r.vendorName}</div>
            <div style={{ fontSize: 14, fontWeight: 500 }}>{r.title}</div>
            {r.terms?.commissionDescription && (
              <div style={{ fontSize: 12, color: theme.textMuted, marginTop: 2 }}>{r.terms.commissionDescription}</div>
            )}
            {r.reasons.length > 0 && (
              <div style={{ fontSize: 11, color: theme.accent, marginTop: 6 }}>
                {r.reasons.slice(0, 2).join(' · ')}
              </div>
            )}
          </Link>
        ))}
      </div>
    </Card>
  );
}

function ctaForStatus(s: MyStatus): string {
  switch (s) {
    case 'approved':
      return 'View link';
    case 'pending':
      return 'View application';
    case 'rejected':
      return 'View & reapply';
    case 'cancelled':
    case 'none':
    default:
      return 'View & apply';
  }
}

interface CreatorProfile {
  id: string;
  email: string;
  name: string;
  handle: string | null;
  bio: string | null;
}

interface RequestRow {
  id: string;
  status: string;
}

/** Three-step nudge for new creators: handle, bio, first application.
 *  Card disappears once everything's done; never shown for creators
 *  who already filled in their profile. */
function CreatorOnboarding() {
  const profile = useQuery({
    queryKey: ['creator-my-profile'],
    queryFn: () => creatorApi<CreatorProfile>('/creators/me'),
    staleTime: 30_000,
    retry: false,
  });
  const requests = useQuery({
    queryKey: ['creator-my-requests'],
    queryFn: () => creatorApi<{ requests: RequestRow[] }>('/creators/me/requests'),
    staleTime: 30_000,
    retry: false,
  });

  if (!profile.data) return null;
  const handleSet = !!profile.data.handle && profile.data.handle.length > 0;
  const bioSet = !!profile.data.bio && profile.data.bio.length > 0;
  const hasApplied = (requests.data?.requests ?? []).length > 0;
  const complete = handleSet && bioSet && hasApplied;
  if (complete) return null;

  const items = [
    { done: true, label: 'Account created', href: null as string | null },
    { done: handleSet, label: 'Pick a handle', hint: 'Used as the default slug for your share links.', href: '/creator/profile' },
    { done: bioSet, label: 'Add a short bio', hint: 'Brands see this on your applications.', href: '/creator/profile' },
    { done: hasApplied, label: 'Apply to your first program', hint: 'Browse below and click "View & apply" on anything that fits.', href: null },
  ];

  return (
    <Card style={{ marginBottom: 18 }}>
      <div style={{ fontSize: 15, fontWeight: 500, marginBottom: 4 }}>Getting started</div>
      <div style={{ fontSize: 13, color: theme.textMuted, marginBottom: 14 }}>
        Three quick steps to put your best foot forward when applying. Card disappears when done.
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {items.map((it, i) => (
          <CreatorStep key={i} done={it.done} label={it.label} hint={it.hint} href={it.href} />
        ))}
      </div>
    </Card>
  );
}

function CreatorStep({ done, label, hint, href }: { done: boolean; label: string; hint?: string; href: string | null }) {
  const inner = (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '10px 12px',
        background: done ? theme.successSoft : theme.surface2,
        border: `1px solid ${done ? `${theme.success}44` : theme.borderSubtle}`,
        borderRadius: theme.radiusSm,
      }}
    >
      <div style={{ color: done ? theme.success : theme.textDim, display: 'inline-flex' }}>
        {done ? <CheckCircle2 size={18} /> : <Circle size={18} />}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 500, color: theme.text, textDecoration: done ? 'line-through' : 'none' }}>
          {label}
        </div>
        {hint && !done && <div style={{ fontSize: 12, color: theme.textDim, marginTop: 2 }}>{hint}</div>}
      </div>
    </div>
  );
  if (done || !href) return inner;
  return <Link to={href} style={{ textDecoration: 'none' }}>{inner}</Link>;
}
