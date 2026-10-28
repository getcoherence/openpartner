/**
 * Admin → Tracking health: where partner clicks and conversions go
 * missing (GET /admin/tracking-health, apps/api/src/tracking-health.ts).
 *
 * A dashboard of tracked sales looks the same whether 2% or 20% of them
 * went missing on one browser or one checkout path. This page shows the
 * gaps instead: clicks that never reached a page running the script,
 * browsers whose stitch rate trails the rest, conversions that credited
 * nobody and why, input OpenPartner had to drop, and when each integration
 * last delivered anything. It says plainly what it can't see: a sale that
 * left no trace at all.
 *
 * Setup checks come first (GET /admin/tracking-health/setup,
 * apps/api/src/setup-checks.ts): pass or fail for each step of the chain,
 * from a partner who can share a program to Stripe's events and the
 * partner codes' discounts, so a brand whose tracking never worked doesn't
 * read "Nothing unusual". The checkbox beside them is the `tracking_alerts`
 * setting that emails a check turning failing and a new flag.
 *
 * Each program there can send a test click (POST and GET
 * /admin/tracking-health/test-click, apps/api/src/test-clicks.ts): a
 * single-use link opened in a new tab, followed until the brand's site has
 * reported it landing and linked it to a signup. A test click is never a
 * Click, so it's credited, paid and counted nowhere.
 *
 * Flags follow (GET /admin/tracking-health/flags,
 * apps/api/src/tracking-flags.ts): a browser or a partner that changed
 * against its own recent past, which one window can't show.
 */
import { useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import { ApiError, api } from '../../api.js';
import { theme } from '../../theme.js';
import { useShareUrlRoot } from '../../lib/shareUrl.js';
import { useIsMobile } from '../../lib/useMediaQuery.js';
import { Button, Card, ErrorBanner, Page, SectionHeading, Select, Stat, Table, formatDate, money } from '../../ui.js';
import { TenantLink } from '../../tenant-link.js';

interface FunnelCounts {
  clicks: number;
  landed: number;
  stitched: number;
  converted: number;
}

type UnattributedReason = 'no_click' | 'excluded' | 'outside_window' | 'other';

type IssueKind =
  | 'identify_unknown_click'
  | 'landing_unknown_click'
  | 'conversion_unknown_click'
  | 'stripe_unknown_click'
  | 'stripe_foreign_reference'
  | 'coupon_unknown_code'
  | 'reward_code_refused';

export interface TrackingHealthReport {
  window: { days: number; since: string; programId: string | null };
  funnel: FunnelCounts & { flagged: number; bots: number };
  landingReported: boolean;
  byBrowser: Array<FunnelCounts & { browser: string; device: string }>;
  unattributed: {
    events: number;
    byReason: Array<{ reason: UnattributedReason; events: number; value: Array<{ currency: string; amount: number }> }>;
  };
  coupons: { overrodeLink: number };
  codes: Array<{ partnerId: string; partnerName: string; customers: number; codeOnly: number }>;
  stripe: { recovered: number };
  issues: Array<{
    kind: IssueKind;
    count: number;
    days: number;
    sampleRef: string | null;
    /** What went wrong with the latest one, for kinds that know. */
    detail?: string | null;
    lastSeenAt: string;
  }>;
  signals: {
    lastClickAt: string | null;
    lastLandingAt: string | null;
    lastStitchAt: string | null;
    lastStripeEventAt: string | null;
    lastPostbackAt: string | null;
  };
}

type PartnerSignal = 'linked_customer' | 'partner_click' | 'partner_code';

type NotCreditableReason = 'outside_window' | 'inactive_code' | 'excluded';

const NOT_CREDITABLE: Record<NotCreditableReason, string> = {
  outside_window: 'outside the window',
  inactive_code: 'with a code deactivated before the payment',
  excluded: 'with only flagged clicks or revoked partners',
};

/** GET /admin/tracking-health/stripe (apps/api/src/stripe-reconciliation.ts). */
export type StripeReconciliationReport =
  | {
      available: true;
      window: { days: number; since: string };
      computedAt: string;
      livemode: boolean;
      truncated: boolean;
      counts: { payments: number; credited: number; recorded: number; missed: number; notCreditable: number; unreferred: number };
      notCreditableReasons: Record<NotCreditableReason, number>;
      totals: Array<{
        currency: string;
        stripe: number;
        recorded: number;
        credited: number;
        missed: number;
        notCreditable: number;
        unreferred: number;
      }>;
      missed: Array<{
        kind: 'invoice' | 'checkout';
        id: string;
        created: string;
        amount: number;
        currency: string;
        signals: PartnerSignal[];
        dashboardUrl: string | null;
      }>;
    }
  | { available: false; reason: 'not_connected' | 'reconnect_needed' | 'missing_permissions' | 'stripe_error'; detail?: string };

interface LinkageRate {
  clicks: number;
  hits: number;
  rate: number;
}

interface SalesTiming {
  sales: number;
  medianSeconds: number;
  /** Sales within a minute of the click. */
  fast: number;
  fastShare: number;
}

export type TrackingFlag =
  | {
      kind: 'linkage_drop';
      subject: string;
      browser: string;
      device: string;
      metric: 'landed' | 'linked';
      recent: LinkageRate;
      baseline: LinkageRate;
    }
  | {
      kind: 'fast_sales';
      subject: string;
      partnerId: string;
      partnerName: string;
      reason: 'collapsed' | 'mostly_instant';
      recent: SalesTiming;
      baseline: SalesTiming | null;
    };

export type SetupCheckStatus = 'pass' | 'fail' | 'waiting' | 'unknown';

/** GET /admin/tracking-health/setup (apps/api/src/setup-checks.ts). */
export interface SetupChecksReport {
  computedAt: string;
  checks: Array<{
    id: 'partners' | 'destination' | 'script' | 'linking' | 'stripe' | 'codes';
    title: string;
    subject: string;
    program: { id: string; name: string } | null;
    status: SetupCheckStatus;
    summary: string;
    fix: string | null;
  }>;
}

export type TestClickStepStatus = 'done' | 'waiting' | 'missing' | 'pending';

/** GET /admin/tracking-health/test-click/:id (apps/api/src/test-clicks.ts). */
export interface TestClickReport {
  id: string;
  program: { id: string; name: string };
  createdAt: string;
  expiresAt: string;
  state: 'waiting' | 'passed' | 'expired';
  destination: string | null;
  steps: Array<{
    id: 'click' | 'landing' | 'identify';
    title: string;
    status: TestClickStepStatus;
    at: string | null;
    summary: string;
    fix: string | null;
  }>;
}

/** GET /admin/tracking-health/flags (apps/api/src/tracking-flags.ts). */
export interface TrackingFlagsReport {
  computedAt: string;
  windows: {
    linkage: { baselineSince: string; recentSince: string; until: string };
    sales: { baselineSince: string; recentSince: string; until: string };
  };
  flags: TrackingFlag[];
}

const SIGNALS: Record<PartnerSignal, string> = {
  linked_customer: 'customer came from a partner click',
  partner_click: 'partner click on the checkout',
  partner_code: "partner's promotion code",
};

interface ProgramOption {
  id: string;
  name: string;
}

const DAY_OPTIONS = [7, 30, 90] as const;

const REASONS: Record<UnattributedReason, { label: string; hint: string }> = {
  no_click: {
    label: 'No partner click on record',
    hint: 'The customer was never linked to a partner click. This includes every customer who came without one, so it is the most that could be missing, not what is.',
  },
  excluded: {
    label: 'Only excluded clicks',
    hint: 'Every click behind the customer was flagged as fraud, or belongs to a revoked partner.',
  },
  outside_window: {
    label: 'Click outside the window',
    hint: "The customer's partner clicks are all older than the program's attribution window.",
  },
  other: {
    label: 'Recorded before the click was linked',
    hint: 'A usable click inside the window and still no credit: the conversion arrived before its click was linked to the customer, and the call that linked it (POST /attribution/conversions with your own userId) credits only its own conversion. Link the click first (identify) and those that follow are credited.',
  },
};

const ISSUES: Record<IssueKind, { label: string; fix: string }> = {
  identify_unknown_click: {
    label: 'identify() named an unknown click',
    fix: "The script tag's data-api-url (or the SDK's apiUrl) probably points at another program. Copy the tag from Integrations again.",
  },
  landing_unknown_click: {
    label: 'Landing report named an unknown click',
    fix: "Same cause as identify: the script tag's API URL names another program.",
  },
  conversion_unknown_click: {
    label: 'Conversion or postback named an unknown click',
    fix: 'The sender is passing something other than the {click_id} it received, or a click from another program.',
  },
  stripe_unknown_click: {
    label: 'Stripe checkout carried an unknown click',
    fix: "client_reference_id looked like a click id but isn't one of this program's: a stale link, or another program's script on the page.",
  },
  stripe_foreign_reference: {
    label: 'Stripe checkout carried your own reference',
    fix: 'Your Checkout Sessions put your own id (an order or user id) in client_reference_id, so partner clicks cannot ride on it. Pass the referral there, or link customers with openpartner_user_id metadata.',
  },
  coupon_unknown_code: {
    label: 'Coupon redemption with an unknown code',
    fix: 'POST /coupons/redeem was sent a code no partner holds: a typo, a deactivated code, or a code from another program.',
  },
  reward_code_refused: {
    label: "Stripe refused a partner code's discount",
    fix: 'Customers who enter that code pay full price. Stripe said why, under the code. The setup checks above count the codes still without one.',
  },
};

function pct(part: number, whole: number): string {
  if (whole <= 0) return '—';
  return `${Math.round((part / whole) * 100)}%`;
}

function rate(part: number, whole: number): number | null {
  return whole > 0 ? part / whole : null;
}

/** Value per currency, never added across currencies. */
function values(list: Array<{ currency: string; amount: number }>): string {
  if (list.length === 0) return '—';
  return list.map((v) => money(v.amount, v.currency)).join(' + ');
}

/** " (2 outside the window, 1 with a code deactivated before the payment)", or nothing. */
function notCreditableWhy(reasons: Record<NotCreditableReason, number>): string {
  const parts = (Object.keys(NOT_CREDITABLE) as NotCreditableReason[])
    .filter((k) => reasons[k] > 0)
    .map((k) => `${reasons[k].toLocaleString()} ${NOT_CREDITABLE[k]}`);
  return parts.length ? ` (${parts.join(', ')})` : '';
}

/** A code whose customers almost never clicked the partner's own link. */
function clickless(row: { customers: number; codeOnly: number }): boolean {
  return row.codeOnly >= 5 && row.codeOnly / row.customers >= 0.8;
}

function Muted({ children }: { children: ReactNode }) {
  return <div style={{ fontSize: 13, color: theme.textMuted, lineHeight: 1.5 }}>{children}</div>;
}

/** A browser whose stitch rate is well under the account's: flag it. */
function lagging(row: FunnelCounts, overall: number | null): boolean {
  const r = rate(row.stitched, row.clicks);
  return overall != null && r != null && row.clicks >= 20 && r < overall * 0.6;
}

export function AdminTrackingHealth() {
  const isMobile = useIsMobile();
  const [params, setParams] = useSearchParams();
  const programs = useQuery({
    queryKey: ['campaigns'],
    queryFn: () => api<{ programs: ProgramOption[] }>('/programs'),
  }).data?.programs;
  const requested = params.get('program');
  const program = requested && programs ? programs.find((p) => p.id === requested) : undefined;
  const programId = requested && (!programs || program) ? requested : undefined;
  const daysParam = Number(params.get('days'));
  const days = (DAY_OPTIONS as readonly number[]).includes(daysParam) ? daysParam : 30;
  const setParam = (key: string, value: string) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (value) next.set(key, value);
        else next.delete(key);
        return next;
      },
      { replace: true },
    );

  const report = useQuery({
    queryKey: ['tracking-health', days, programId ?? null],
    queryFn: () => {
      const qs = new URLSearchParams({ days: String(days) });
      if (programId) qs.set('programId', programId);
      return api<TrackingHealthReport>(`/admin/tracking-health?${qs}`);
    },
  });
  const data = report.data;
  const f = data?.funnel;
  const overallStitch = f ? rate(f.stitched, f.clicks) : null;

  return (
    <Page
      title="Tracking health"
      subtitle={`Where partner clicks and conversions go missing, over the last ${days} days${program ? `, for ${program.name}` : ''}.`}
      actions={
        <>
          {((programs?.length ?? 0) > 1 || program) && (
            <Select
              aria-label="Program"
              value={program?.id ?? ''}
              onChange={(e) => setParam('program', e.target.value)}
              style={{ width: 'auto', maxWidth: '100%', padding: '6px 10px', fontSize: 13 }}
            >
              <option value="">All programs</option>
              {programs?.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          )}
          <Select
            aria-label="Window"
            value={String(days)}
            onChange={(e) => setParam('days', e.target.value === '30' ? '' : e.target.value)}
            style={{ width: 'auto', padding: '6px 10px', fontSize: 13 }}
          >
            {DAY_OPTIONS.map((d) => (
              <option key={d} value={d}>
                Last {d} days
              </option>
            ))}
          </Select>
        </>
      }
    >
      <SetupChecksSection />
      <FlagsSection />

      {report.error && <ErrorBanner error={report.error} />}
      {report.isLoading && <Muted>Loading…</Muted>}

      {data && f && (
        <>
          <SectionHeading>Partner link clicks</SectionHeading>
          <div
            className="op-grid-collapse"
            style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(4, minmax(0, 1fr))', gap: 12 }}
          >
            <Stat
              label="Clicks"
              value={f.clicks.toLocaleString()}
              hint={[
                f.flagged ? `${f.flagged.toLocaleString()} flagged as fraud, not counted` : null,
                f.bots ? `${f.bots.toLocaleString()} from bots, not counted` : null,
              ]
                .filter(Boolean)
                .join(' · ') || 'Real visitors, after fraud flags and bots.'}
            />
            <Stat
              label="Landed"
              value={data.landingReported ? pct(f.landed, f.clicks) : 'Not measured'}
              hint={
                data.landingReported
                  ? `${f.landed.toLocaleString()} reached a page running the script.`
                  : 'Shows up once the latest script tag (or SDK) is on your site.'
              }
            />
            <Stat
              label="Stitched"
              value={pct(f.stitched, f.clicks)}
              hint={`${f.stitched.toLocaleString()} linked to a customer: identify(), a Stripe checkout, or a conversion call.`}
            />
            <Stat
              label="Credited"
              value={pct(f.converted, f.clicks)}
              hint={`${f.converted.toLocaleString()} credited with at least one conversion.`}
            />
          </div>
          {data.landingReported && f.clicks > 0 && f.landed / f.clicks < 0.7 && (
            <Card style={{ marginTop: 12, borderColor: theme.warn }}>
              <Muted>
                <strong style={{ color: theme.text }}>
                  {pct(f.clicks - f.landed, f.clicks)} of clicks never reached a page running the script.
                </strong>{' '}
                Common causes: a redirect on the landing page that drops <code>?cref=</code>, a destination page without
                the script tag, or a cookie banner the visitor never answered (the script waits for consent when{' '}
                <code>data-consent=&quot;pending&quot;</code> is set). Destinations that go straight to a Stripe Payment Link
                never land by design.
              </Muted>
            </Card>
          )}

          <StripeReconciliationSection days={days} />

          <SectionHeading>By browser</SectionHeading>
          <Table
            columns={[
              'Browser',
              'Device',
              { label: 'Clicks', align: 'right' },
              { label: 'Landed', align: 'right' },
              { label: 'Stitched', align: 'right' },
              { label: 'Credited', align: 'right' },
            ]}
            rows={data.byBrowser.map((b) => [
              b.browser,
              b.device,
              b.clicks.toLocaleString(),
              data.landingReported ? pct(b.landed, b.clicks) : '—',
              <span
                key="s"
                style={lagging(b, overallStitch) ? { color: theme.warn, fontWeight: 600 } : undefined}
                title={lagging(b, overallStitch) ? 'Well under the account-wide stitch rate.' : undefined}
              >
                {pct(b.stitched, b.clicks)}
              </span>,
              pct(b.converted, b.clicks),
            ])}
            empty="No partner link clicks in this window."
          />
          <div style={{ marginTop: 8 }}>
            <Muted>
              A browser stitching well below the rest (highlighted) is losing the click between visit and signup: Safari
              clears script storage after 7 days without a visit, and in-app browsers (Instagram, TikTok, Facebook) keep
              storage of their own. Calling identify() as early as you can, and setting the referral cookie from your
              server, both close that gap.
            </Muted>
          </div>

          <SectionHeading>Conversions that credited nobody</SectionHeading>
          <Table
            columns={['Why', { label: 'Conversions', align: 'right' }, { label: 'Value', align: 'right' }]}
            rows={data.unattributed.byReason.map((r) => [
              <div key="r">
                <div>{REASONS[r.reason].label}</div>
                <div style={{ fontSize: 12, color: theme.textMuted, marginTop: 2, maxWidth: 560 }}>{REASONS[r.reason].hint}</div>
              </div>,
              r.events.toLocaleString(),
              values(r.value),
            ])}
            empty="Every conversion in this window credited a partner."
          />
          {program && (
            <div style={{ marginTop: 8 }}>
              <Muted>Account-wide: a conversion belongs to no program until it is credited.</Muted>
            </div>
          )}

          <SectionHeading>Dropped by OpenPartner</SectionHeading>
          <Table
            columns={['What', { label: 'Times', align: 'right' }, 'Last seen', 'Latest value']}
            rows={data.issues.map((i) => [
              <div key="k">
                <div>{ISSUES[i.kind]?.label ?? i.kind}</div>
                <div style={{ fontSize: 12, color: theme.textMuted, marginTop: 2, maxWidth: 520 }}>{ISSUES[i.kind]?.fix}</div>
              </div>,
              `${i.count.toLocaleString()}${i.days > 1 ? ` over ${i.days} days` : ''}`,
              formatDate(i.lastSeenAt, { relative: true }),
              <div key="s">
                {i.sampleRef ? <code>{i.sampleRef}</code> : '—'}
                {i.detail && (
                  <div style={{ fontSize: 12, color: theme.textMuted, marginTop: 2, maxWidth: 360 }}>{i.detail}</div>
                )}
              </div>,
            ])}
            empty="Nothing dropped in this window."
          />

          <SectionHeading>Credit decisions</SectionHeading>
          <div
            className="op-grid-collapse"
            style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(2, minmax(0, 1fr))', gap: 12 }}
          >
            <Stat
              label="Coupon took credit from a link"
              value={data.coupons.overrodeLink.toLocaleString()}
              hint="Conversions credited to a coupon's partner while another partner, whose link click was in the window, got nothing. Under last click the code, used at checkout, wins. To let the link win, turn on “Partner links beat coupon codes” in the program's settings."
            />
            <Stat
              label="Stripe events recovered"
              value={data.stripe.recovered.toLocaleString()}
              hint="Recorded by the Stripe catch-up (hosted Stripe connections) after the webhook missed them. Above zero means webhook deliveries are failing."
            />
          </div>

          {data.codes.length > 0 && (
            <>
              <SectionHeading>Partner codes</SectionHeading>
              <Table
                columns={[
                  'Partner',
                  { label: 'Customers credited', align: 'right' },
                  { label: 'Code, no click of theirs', align: 'right' },
                  { label: 'Share', align: 'right' },
                ]}
                rows={data.codes.map((c) => [
                  c.partnerName,
                  c.customers.toLocaleString(),
                  c.codeOnly.toLocaleString(),
                  <span
                    key="s"
                    style={clickless(c) ? { color: theme.warn, fontWeight: 600 } : undefined}
                    title={clickless(c) ? 'Almost every customer came through the code alone.' : undefined}
                  >
                    {pct(c.codeOnly, c.customers)}
                  </span>,
                ])}
              />
              <div style={{ marginTop: 8 }}>
                <Muted>
                  Customers credited through a partner&rsquo;s code who never clicked that partner&rsquo;s link first. A
                  code that brings almost nobody through the partner&rsquo;s own link may have spread beyond their
                  audience, to coupon sites or browser extensions. For a podcast or video read, where people type the
                  code they heard, it&rsquo;s normal.
                </Muted>
              </div>
            </>
          )}

          <SectionHeading>Last received</SectionHeading>
          <Card>
            <div
              className="op-grid-collapse"
              style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(5, minmax(0, 1fr))', gap: 12 }}
            >
              {(
                [
                  ['Partner click', data.signals.lastClickAt],
                  ['Landing report', data.signals.lastLandingAt],
                  ['Stitch', data.signals.lastStitchAt],
                  ['Stripe event', data.signals.lastStripeEventAt],
                  ['Postback', data.signals.lastPostbackAt],
                ] as const
              ).map(([label, at]) => (
                <div key={label}>
                  <div style={{ fontSize: 12, color: theme.textMuted }}>{label}</div>
                  <div style={{ fontSize: 14, marginTop: 4 }}>{at ? formatDate(at, { relative: true }) : 'Never'}</div>
                </div>
              ))}
            </div>
          </Card>

          <div style={{ marginTop: 20 }}>
            <Muted>
              What this can&rsquo;t see: a sale that left no trace at all, with no click kept in the browser or by your
              server, no linked account and no partner code. Those can&rsquo;t be credited anywhere. What it does show
              are the common places where a trace starts and then stops.
            </Muted>
          </div>
        </>
      )}
    </Page>
  );
}

/** "12 seconds", "4 minutes", "2.5 hours", "3 days" (formatDuration in tracking-flags.ts). */
function duration(seconds: number): string {
  const unit = (n: number, word: string) => {
    const v = n >= 10 ? Math.round(n) : Math.round(n * 10) / 10;
    return `${v} ${word}${v === 1 ? '' : 's'}`;
  };
  if (seconds < 90) return unit(Math.max(0, Math.round(seconds)), 'second');
  if (seconds < 90 * 60) return unit(seconds / 60, 'minute');
  if (seconds < 36 * 3600) return unit(seconds / 3600, 'hour');
  return unit(seconds / 86_400, 'day');
}

function flagText(flag: TrackingFlag): { headline: string; detail: string } {
  if (flag.kind === 'linkage_drop') {
    const sample = `Clicks one to eight days old (${flag.recent.clicks.toLocaleString()}) against the four weeks before (${flag.baseline.clicks.toLocaleString()}).`;
    if (flag.metric === 'landed') {
      return {
        headline: `${flag.browser} (${flag.device}): ${pct(flag.recent.hits, flag.recent.clicks)} of clicks reached a page running the script within a day, down from ${pct(flag.baseline.hits, flag.baseline.clicks)}`,
        detail: `${sample} A fall like this usually follows a change on your site: a new cookie banner or consent setup, a redirect that drops ?cref=, or a page that lost the script tag.`,
      };
    }
    return {
      headline: `${flag.browser} (${flag.device}): ${pct(flag.recent.hits, flag.recent.clicks)} of clicks were linked to a customer within a day, down from ${pct(flag.baseline.hits, flag.baseline.clicks)}`,
      detail: `${sample} A click is linked by identify(), a Stripe checkout or a conversion call. If landings held up, look at what changed between the visit and the signup: identify() called later, a new signup flow, or storage this browser now clears sooner.`,
    };
  }
  const r = flag.recent;
  const headline =
    flag.reason === 'collapsed' && flag.baseline
      ? `${flag.partnerName}: half of their sales now come within ${duration(r.medianSeconds)} of the click, against ${duration(flag.baseline.medianSeconds)} before`
      : `${flag.partnerName}: ${r.fast} of ${r.sales} sales in the last two weeks came within a minute of the click`;
  const sample = flag.baseline
    ? `The first sale through each of the partner's link clicks: ${r.sales} in the last two weeks against ${flag.baseline.sales} in the three months before.`
    : `The first sale through each of the partner's link clicks, in the last two weeks.`;
  return {
    headline,
    detail: `${sample} Real buyers rarely pay that fast. A browser extension or a coupon site that clicks the link at checkout takes the credit without bringing the customer. Look at where their clicks come from before you approve their commissions.`,
  };
}

const STATUS: Record<SetupCheckStatus, { label: string; bg: string; fg: string }> = {
  fail: { label: 'failing', bg: theme.dangerSoft, fg: theme.danger },
  unknown: { label: 'can’t check', bg: theme.warnSoft, fg: theme.warn },
  waiting: { label: 'waiting', bg: theme.surface2, fg: theme.textMuted },
  pass: { label: 'passing', bg: theme.successSoft, fg: theme.success },
};

function CheckStatus({ status }: { status: SetupCheckStatus }) {
  const s = STATUS[status];
  return (
    <span
      style={{
        display: 'inline-block',
        background: s.bg,
        color: s.fg,
        padding: '3px 9px',
        borderRadius: 999,
        fontSize: 11,
        fontWeight: 600,
        whiteSpace: 'nowrap',
      }}
    >
      {s.label}
    </span>
  );
}

/** "2 failing, 1 can't check, 4 passing": the order of STATUS. */
function checkCounts(checks: SetupChecksReport['checks']): string {
  return (Object.keys(STATUS) as SetupCheckStatus[])
    .map((s) => [s, checks.filter((c) => c.status === s).length] as const)
    .filter(([, n]) => n > 0)
    .map(([s, n]) => `${n} ${STATUS[s].label}`)
    .join(', ');
}

/**
 * Pass or fail for each step of the tracking chain, per program and then
 * account-wide, with the setting that emails a check turning failing (and
 * a new flag; the `tracking_alerts` setting). Loads on its own: it fetches
 * each program's destination and reads Stripe, which takes a few seconds.
 */
function SetupChecksSection() {
  const qc = useQueryClient();
  const key = ['tracking-health-setup'];
  const query = useQuery({
    queryKey: key,
    queryFn: () => api<SetupChecksReport>('/admin/tracking-health/setup'),
  });
  const again = useMutation({
    mutationFn: () => api<SetupChecksReport>('/admin/tracking-health/setup?refresh=1'),
    onSuccess: (fresh) => qc.setQueryData(key, fresh),
  });
  const alerts = useQuery({
    queryKey: ['tracking-alerts'],
    queryFn: () => api<{ email: boolean }>('/config/tracking-alerts'),
  });
  const save = useMutation({
    mutationFn: (email: boolean) => api<{ email: boolean }>('/config/tracking-alerts', { method: 'POST', body: { email } }),
    onSuccess: (next) => qc.setQueryData(['tracking-alerts'], next),
  });
  const testRoot = useShareUrlRoot();
  // The latest test click per program, while its panel is open.
  const [tests, setTests] = useState<Record<string, { id: string; url: string }>>({});
  const [testErrors, setTestErrors] = useState<Record<string, string>>({});
  // Programs whose test link is being made. Each press is its own request,
  // so starting a second program's test doesn't drop the first's.
  const [making, setMaking] = useState<ReadonlySet<string>>(new Set());
  const startTest = async (programId: string) => {
    if (!testRoot) return;
    // Opened now, inside the click, so the browser doesn't block it as a
    // popup; it's sent to the link once the API has made it.
    const tab = window.open('', '_blank');
    setTestErrors(({ [programId]: _dropped, ...rest }) => rest);
    setMaking((prev) => new Set(prev).add(programId));
    try {
      const made = await api<{ id: string; path: string; expiresAt: string }>('/admin/tracking-health/test-click', {
        method: 'POST',
        body: { programId },
      });
      const url = `${testRoot}${made.path}`;
      if (tab) {
        // The brand's page gets no handle on this one.
        tab.opener = null;
        tab.location.href = url;
      }
      setTests((prev) => ({ ...prev, [programId]: { id: made.id, url } }));
    } catch (err) {
      tab?.close();
      setTestErrors((prev) => ({ ...prev, [programId]: testClickErrorMessage(err) }));
    } finally {
      setMaking((prev) => {
        const next = new Set(prev);
        next.delete(programId);
        return next;
      });
    }
  };

  const r = query.data;
  // Grouped by program id, not name: two programs may share a name.
  const groups: Array<{ key: string; name: string; programId: string | null; testable: boolean; checks: SetupChecksReport['checks'] }> = [];
  for (const c of r?.checks ?? []) {
    const key = c.program?.id ?? 'account';
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.checks.push(c);
    else groups.push({ key, name: c.program?.name ?? 'Whole account', programId: c.program?.id ?? null, testable: false, checks: [c] });
    // A program without a script check sends partners to Stripe's own
    // checkout, where nothing lands to test.
    if (c.id === 'script') groups[groups.length - 1]!.testable = true;
  }
  const failing = r?.checks.filter((c) => c.status === 'fail').length ?? 0;

  return (
    <>
      <SectionHeading
        actions={
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            {alerts.data && (
              <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, color: theme.textMuted, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={alerts.data.email}
                  disabled={save.isPending}
                  onChange={(e) => save.mutate(e.target.checked)}
                  style={{ accentColor: theme.accent, margin: 0 }}
                />
                Email admins about failing checks and new flags
              </label>
            )}
            {r && (
              <Button variant="ghost" size="sm" disabled={again.isPending} onClick={() => again.mutate()}>
                {again.isPending ? 'Checking…' : 'Check again'}
              </Button>
            )}
          </div>
        }
      >
        Setup checks
      </SectionHeading>
      {query.error && <ErrorBanner error={query.error} />}
      {again.error && <ErrorBanner error={again.error} />}
      {save.error && <ErrorBanner error={save.error} />}
      {query.isLoading && <Muted>Checking each step, from your partner links to your Stripe…</Muted>}
      {r && (
        <Card style={failing ? { borderColor: theme.danger } : undefined}>
          <div style={{ fontSize: 14, fontWeight: 600, color: theme.text }}>
            {r.checks.length === 0
              ? 'Nothing to check yet: create a program to start.'
              : failing
                ? `${failing} of ${r.checks.length} ${r.checks.length === 1 ? 'check' : 'checks'} ${failing === 1 ? 'is' : 'are'} failing.`
                : r.checks.every((c) => c.status === 'pass')
                  ? 'Every check passes.'
                  : `Nothing failing: ${checkCounts(r.checks)}.`}
          </div>
          {failing > 0 && (
            <div style={{ marginTop: 4 }}>
              <Muted>{`${checkCounts(r.checks)}. Each failing check says what to change.`}</Muted>
            </div>
          )}
          {groups.map((g) => (
            <div key={g.key} style={{ marginTop: 16 }} data-group={g.key}>
              <div style={{ display: 'flex', gap: 12, alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap' }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: theme.textMuted, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                  {g.name}
                </div>
                {g.programId && g.testable && (
                  <span title={testRoot ? undefined : 'Set your router’s public URL in Settings first.'}>
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={!testRoot || making.has(g.programId)}
                      onClick={() => void startTest(g.programId!)}
                    >
                      {making.has(g.programId) ? 'Making a test link…' : 'Send a test click'}
                    </Button>
                  </span>
                )}
              </div>
              {g.programId && testErrors[g.programId] && (
                <div style={{ marginTop: 8 }}>
                  <ErrorBanner error={testErrors[g.programId]} />
                </div>
              )}
              {g.programId && tests[g.programId] && (
                <TestClickPanel
                  test={tests[g.programId]!}
                  onClose={() =>
                    setTests((prev) => {
                      const next = { ...prev };
                      delete next[g.programId!];
                      return next;
                    })
                  }
                />
              )}
              {g.checks.map((c) => (
                <div
                  key={`${c.id}|${c.subject}`}
                  data-check={c.id}
                  style={{
                    display: 'flex',
                    gap: 12,
                    alignItems: 'flex-start',
                    padding: '10px 0',
                    borderTop: `1px solid ${theme.borderSubtle}`,
                    marginTop: 8,
                  }}
                >
                  <div style={{ width: 92, flexShrink: 0 }}>
                    <CheckStatus status={c.status} />
                  </div>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 14, fontWeight: 600, color: theme.text }}>{c.title}</div>
                    <div style={{ fontSize: 13, color: theme.text, marginTop: 2, lineHeight: 1.5, overflowWrap: 'anywhere' }}>
                      {c.summary}
                    </div>
                    {c.fix && c.status !== 'pass' && (
                      <div style={{ marginTop: 4 }}>
                        <Muted>{c.fix}</Muted>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          ))}
          <div style={{ marginTop: 12 }}>
            <Muted>Checked {formatDate(r.computedAt, { relative: true })}.</Muted>
          </div>
        </Card>
      )}
    </>
  );
}

const TEST_CLICK_ERRORS: Record<string, string> = {
  links_paused:
    'Your partner links don’t record clicks right now (the account is waiting for approval, or is being deleted), so a test click can’t either.',
  program_not_active: 'This program isn’t running, so its links record no clicks.',
  stripe_checkout_destination:
    'This program sends partners straight to a Stripe checkout, where nothing lands to test. The destination check covers it.',
  too_many_test_clicks: 'That’s as many test clicks as one day allows. Try again tomorrow.',
};

function testClickErrorMessage(err: unknown): string {
  const code = err instanceof ApiError ? (err.detail as { error?: string } | undefined)?.error : undefined;
  return (code && TEST_CLICK_ERRORS[code]) ?? (err instanceof Error ? err.message : String(err));
}

const STEP_STATUS: Record<TestClickStepStatus, { label: string; bg: string; fg: string }> = {
  done: { label: 'done', bg: theme.successSoft, fg: theme.success },
  waiting: { label: 'waiting', bg: theme.surface2, fg: theme.textMuted },
  missing: { label: 'not seen', bg: theme.warnSoft, fg: theme.warn },
  pending: { label: 'next', bg: theme.surface2, fg: theme.textDim },
};

const timeOf = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

/**
 * One test click, followed every two seconds until it passes or expires:
 * the link opened, the brand's script reporting it, a signup linked to it.
 * The first step that didn't happen says what to fix. Until the link is
 * opened it can be opened here or copied (to try a phone, or a private
 * window); it works once.
 */
function TestClickPanel({ test, onClose }: { test: { id: string; url: string }; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const query = useQuery({
    queryKey: ['tracking-health-test-click', test.id],
    queryFn: () => api<TestClickReport>(`/admin/tracking-health/test-click/${test.id}`),
    refetchInterval: (q) => (q.state.data && q.state.data.state !== 'waiting' ? false : 2_000),
  });
  const t = query.data;
  const opened = t?.steps[0]?.status === 'done';
  const headline = !t
    ? 'Test click'
    : t.state === 'passed'
      ? 'Test click passed: a partner’s click reaches your site and is linked to the customer who signs up.'
      : t.state === 'expired'
        ? 'Test click expired.'
        : opened
          ? 'Test click in progress.'
          : `Test click: open the link by ${timeOf(t.expiresAt)}.`;

  return (
    <div
      data-test-click={test.id}
      style={{
        marginTop: 10,
        padding: '12px 14px',
        background: theme.surface2,
        borderRadius: theme.radiusSm,
        border: `1px solid ${t?.state === 'passed' ? theme.success : theme.borderSubtle}`,
      }}
    >
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', justifyContent: 'space-between' }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: theme.text, lineHeight: 1.5 }}>{headline}</div>
        <Button variant="ghost" size="sm" onClick={onClose}>
          Close
        </Button>
      </div>
      {query.error && <ErrorBanner error={query.error} />}
      {t && !opened && t.state === 'waiting' && (
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginTop: 6, fontSize: 13 }}>
          <a href={test.url} target="_blank" rel="noopener noreferrer" style={{ color: theme.accentText }}>
            Open the test link
          </a>
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard.writeText(test.url).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              });
            }}
            style={{ background: 'transparent', border: 'none', padding: 0, cursor: 'pointer', fontSize: 13, color: theme.accentText }}
          >
            {copied ? 'Copied' : 'Copy it'}
          </button>
          <Muted>It works once.</Muted>
        </div>
      )}
      {t?.destination && (
        <div style={{ marginTop: 6, fontSize: 12, color: theme.textMuted, overflowWrap: 'anywhere' }}>
          Sent to <code style={{ fontFamily: theme.fontMono }}>{t.destination}</code>
        </div>
      )}
      {t?.steps.map((s) => (
        <div
          key={s.id}
          data-step={s.id}
          style={{ display: 'flex', gap: 12, alignItems: 'flex-start', padding: '8px 0', borderTop: `1px solid ${theme.borderSubtle}`, marginTop: 8 }}
        >
          <div style={{ width: 92, flexShrink: 0 }}>
            <span
              style={{
                display: 'inline-block',
                background: STEP_STATUS[s.status].bg,
                color: STEP_STATUS[s.status].fg,
                padding: '3px 9px',
                borderRadius: 999,
                fontSize: 11,
                fontWeight: 600,
                whiteSpace: 'nowrap',
              }}
            >
              {STEP_STATUS[s.status].label}
            </span>
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: theme.text }}>
              {s.title}
              {s.at && <span style={{ fontWeight: 400, color: theme.textMuted }}> · {timeOf(s.at)}</span>}
            </div>
            <div style={{ fontSize: 13, color: theme.text, marginTop: 2, lineHeight: 1.5 }}>{s.summary}</div>
            {s.fix && (
              <div style={{ marginTop: 4 }}>
                <Muted>{s.fix}</Muted>
              </div>
            )}
          </div>
        </div>
      ))}
      <div style={{ marginTop: 8 }}>
        <Muted>A test click is never credited, paid or counted, and needs no partner.</Muted>
      </div>
    </div>
  );
}

/**
 * Each browser and partner against its own recent past. Loads on its own:
 * the flags read a few months of sales.
 */
function FlagsSection() {
  const flags = useQuery({
    queryKey: ['tracking-health-flags'],
    queryFn: () => api<TrackingFlagsReport>('/admin/tracking-health/flags'),
  });
  const list = flags.data?.flags ?? [];

  return (
    <>
      <SectionHeading>Flags</SectionHeading>
      {flags.error && <ErrorBanner error={flags.error} />}
      {flags.isLoading && <Muted>Comparing with recent weeks…</Muted>}
      {flags.data && list.length === 0 && (
        <Card>
          <Muted>
            Nothing unusual. Each browser&rsquo;s landing and linking rates, and each partner&rsquo;s time from click to
            sale, are in line with their own recent past.
          </Muted>
        </Card>
      )}
      {list.map((flag) => {
        const { headline, detail } = flagText(flag);
        return (
          <Card key={`${flag.kind}|${flag.subject}`} style={{ marginTop: 12, borderColor: theme.warn }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: theme.text, lineHeight: 1.4 }}>{headline}</div>
            <div style={{ marginTop: 6 }}>
              <Muted>{detail}</Muted>
            </div>
          </Card>
        );
      })}
    </>
  );
}

/**
 * The brand's own Stripe revenue next to what OpenPartner recorded from it
 * and credited to partners. Loads on its own: listing Stripe takes a few
 * seconds, and the rest of the page shouldn't wait for it.
 */
function StripeReconciliationSection({ days }: { days: number }) {
  const qc = useQueryClient();
  const key = ['tracking-health-stripe', days];
  const query = useQuery({
    queryKey: key,
    queryFn: () => api<StripeReconciliationReport>(`/admin/tracking-health/stripe?days=${days}`),
  });
  const refresh = async () => {
    const fresh = await api<StripeReconciliationReport>(`/admin/tracking-health/stripe?days=${days}&refresh=1`);
    qc.setQueryData(key, fresh);
  };
  const r = query.data;

  return (
    <>
      <SectionHeading
        actions={
          r?.available ? (
            <Button variant="ghost" size="sm" onClick={() => void refresh()}>
              Read again
            </Button>
          ) : undefined
        }
      >
        Stripe revenue
      </SectionHeading>
      {query.error && <ErrorBanner error={query.error} />}
      {query.isLoading && <Muted>Reading your Stripe account…</Muted>}
      {r && !r.available && (
        <Card>
          <Muted>
            {r.reason === 'not_connected' && (
              <>
                Connect your Stripe account under <TenantLink to="/admin/integrations">Integrations</TenantLink> to see
                your Stripe revenue next to what OpenPartner recorded and credited, payment by payment.
              </>
            )}
            {r.reason === 'reconnect_needed' && (
              <>
                Your Stripe connection needs reconnecting under{' '}
                <TenantLink to="/admin/integrations">Integrations</TenantLink>.
              </>
            )}
            {r.reason === 'missing_permissions' && (
              <>
                Your Stripe connection can&rsquo;t read invoices, Checkout Sessions and customers, which this needs.
                Reconnect Stripe under <TenantLink to="/admin/integrations">Integrations</TenantLink> to accept them.
              </>
            )}
            {r.reason === 'stripe_error' && (
              <>Stripe didn&rsquo;t answer{r.detail ? `: ${r.detail}` : ''}. Try again in a minute.</>
            )}
          </Muted>
        </Card>
      )}
      {r?.available && (
        <>
          <Table
            columns={[
              'Currency',
              { label: 'In Stripe', align: 'right' },
              { label: 'Recorded', align: 'right' },
              { label: 'Credited to partners', align: 'right' },
              { label: 'Missed sales', align: 'right' },
              { label: 'Not creditable', align: 'right' },
              { label: 'No partner signal', align: 'right' },
            ]}
            rows={r.totals.map((t) => [
              t.currency,
              money(t.stripe, t.currency),
              money(t.recorded, t.currency),
              money(t.credited, t.currency),
              <span key="m" style={t.missed > 0 ? { color: theme.warn, fontWeight: 600 } : undefined}>
                {money(t.missed, t.currency)}
              </span>,
              money(t.notCreditable, t.currency),
              money(t.unreferred, t.currency),
            ])}
            empty="No paid invoices or Checkout payments in Stripe in this window."
          />
          <div style={{ marginTop: 8 }}>
            <Muted>
              {r.counts.payments.toLocaleString()} paid invoices and one-time Checkout payments created in the window:{' '}
              {r.counts.credited.toLocaleString()} credited to a partner, {r.counts.recorded.toLocaleString()} recorded
              without credit, {r.counts.missed.toLocaleString()} missed,{' '}
              {r.counts.notCreditable.toLocaleString()} with a partner signal that wouldn&rsquo;t have earned credit
              {notCreditableWhy(r.notCreditableReasons)}, {r.counts.unreferred.toLocaleString()} with no partner signal.
              Missed means a partner would have been credited had it been recorded. Gross, before refunds. Payments taken outside invoices and Checkout aren&rsquo;t read from
              Stripe; report those with the conversions API.
              {r.truncated && ' Only the most recent 2,000 of each kind were read.'} Read from Stripe{' '}
              {formatDate(r.computedAt, { relative: true })}.
            </Muted>
          </div>
          {r.missed.length > 0 && (
            <>
              <Card style={{ marginTop: 12, borderColor: theme.warn }}>
                <Muted>
                  <strong style={{ color: theme.text }}>
                    {r.counts.missed.toLocaleString()} {r.counts.missed === 1 ? 'payment' : 'payments'} would have
                    credited a partner, but OpenPartner recorded nothing for {r.counts.missed === 1 ? 'it' : 'them'}.
                  </strong>{' '}
                  Usually a webhook that never arrived, or a payment OpenPartner couldn&rsquo;t map. Open it in
                  Stripe to see why.
                </Muted>
              </Card>
              <div style={{ marginTop: 12 }}>
                <Table
                  columns={['Created', 'Payment', { label: 'Amount', align: 'right' }, 'Why it should have counted']}
                  rows={r.missed.map((m) => [
                    formatDate(m.created, { relative: true }),
                    m.dashboardUrl ? (
                      <a key="l" href={m.dashboardUrl} target="_blank" rel="noreferrer" style={{ color: theme.accent }}>
                        <code>{m.id}</code>
                      </a>
                    ) : (
                      <code key="l">{m.id}</code>
                    ),
                    money(m.amount, m.currency),
                    m.signals.map((sig) => SIGNALS[sig]).join('; '),
                  ])}
                />
              </div>
            </>
          )}
        </>
      )}
    </>
  );
}
