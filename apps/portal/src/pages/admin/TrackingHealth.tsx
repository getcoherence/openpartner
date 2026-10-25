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
 */
import type { ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import { api } from '../../api.js';
import { theme } from '../../theme.js';
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
  | 'coupon_unknown_code';

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
  issues: Array<{ kind: IssueKind; count: number; days: number; sampleRef: string | null; lastSeenAt: string }>;
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
              i.sampleRef ? <code key="s">{i.sampleRef}</code> : '—',
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
