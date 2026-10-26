/**
 * Admin → Customer journey: every partner touch for one customer, in order,
 * and who got credit for each conversion and why (GET /events/:id/journey,
 * GET /customers/:userId/journey; apps/api/src/journey.ts).
 *
 * A dashboard says who "won". An affiliate manager looking into a dispute
 * needs the evidence: Ada's click, Bob's click twelve days later, the code
 * used at checkout, the sale, and the rule that picked the winner. Only
 * partner touches are recorded, so paid search, organic and direct visits
 * are gaps in the path, and the page says so.
 *
 * Opened from a commission row (?event=), or by looking a customer up by
 * the id the brand sends to identify (?customer=).
 */
import { useState, type CSSProperties, type FormEvent, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import { Code2, MousePointerClick, Route as RouteIcon } from 'lucide-react';
import { api } from '../../api.js';
import { theme } from '../../theme.js';
import { useIsMobile } from '../../lib/useMediaQuery.js';
import { Button, Card, EmptyState, ErrorBanner, Input, Page, SectionHeading, StatusPill, Table, formatDate, money } from '../../ui.js';
import { TenantLink } from '../../tenant-link.js';

type Model = 'last_click' | 'first_click' | 'linear' | 'position';
type Verdict =
  | 'credited'
  | 'in_window'
  | 'outside_window'
  | 'after_event'
  | 'yielded_to_link'
  | 'flagged'
  | 'partner_revoked'
  | 'no_program';

interface Credit {
  partnerId: string;
  partnerName: string | null;
  weight: number;
}

export interface JourneyTouch {
  clickId: string;
  kind: 'link' | 'code';
  ts: string;
  partner: { id: string; name: string | null };
  program: { id: string; name: string | null };
  code: string | null;
  landingUrl: string | null;
  landedAt: string | null;
  referer: string | null;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  subId: string | null;
  browser: string | null;
  device: string | null;
  country: string | null;
  linkedAt: string | null;
  flagged: boolean;
}

export interface JourneyEvent {
  id: string;
  type: string;
  ts: string;
  value: number | null;
  currency: string | null;
  corrective: boolean;
  credited: Credit[];
}

export interface JourneyDecision {
  eventId: string;
  status: 'credited' | 'corrective' | 'no_identity' | 'no_click' | 'outside_window';
  source: 'window' | 'renewal' | 'latest_conversion' | null;
  model: Model | null;
  candidates: number;
  fromEvent: { id: string; type: string; ts: string } | null;
  touches: Array<{ clickId: string; verdict: Verdict; weight: number | null; pastWindow: boolean; secondsBeforeEvent: number; linkedAfterEvent: boolean }>;
  recorded: Array<{
    attributionId: string;
    clickId: string;
    partnerId: string;
    partnerName: string | null;
    model: Model;
    weight: number;
    computedAt: string;
    commissions: Array<{ id: string; partnerId: string; partnerName: string | null; amount: string; currency: string; status: string; recruiter: boolean }>;
  }>;
  matchesRecord: boolean;
  alternatives: Array<{ model: Model; live: boolean; credits: Credit[] }> | null;
}

export interface Journey {
  userId: string;
  touches: JourneyTouch[];
  events: JourneyEvent[];
  selected: JourneyDecision | null;
  truncated: { touches: boolean; events: boolean };
}

export const MODEL_LABEL: Record<Model, string> = {
  last_click: 'Last click',
  first_click: 'First click',
  linear: 'Linear',
  position: 'Position (40/20/40)',
};

const VERDICT: Record<Verdict, { label: string; bg: string; fg: string }> = {
  credited: { label: 'Credited', bg: theme.successSoft, fg: theme.success },
  in_window: { label: 'In window, no share', bg: theme.surface2, fg: theme.textMuted },
  outside_window: { label: 'Outside its window', bg: theme.surface2, fg: theme.textDim },
  after_event: { label: 'After this sale', bg: theme.surface2, fg: theme.textDim },
  yielded_to_link: { label: 'Gave way to a link', bg: theme.infoSoft, fg: theme.info },
  flagged: { label: 'Fraud-flagged', bg: theme.dangerSoft, fg: theme.danger },
  partner_revoked: { label: 'Partner revoked', bg: theme.dangerSoft, fg: theme.danger },
  no_program: { label: 'Program deleted', bg: theme.surface2, fg: theme.textDim },
};

const pct = (w: number) => `${Math.round(w * 1000) / 10}%`;
const name = (c: { partnerName: string | null; partnerId: string }) => c.partnerName ?? c.partnerId.slice(-8);

/** "12 days before", "8 seconds before", "2 hours after". */
export function gap(seconds: number): string {
  const s = Math.abs(seconds);
  const [n, unit] =
    s < 60 ? [s, 'second'] : s < 3600 ? [Math.round(s / 60), 'minute'] : s < 86_400 ? [Math.round(s / 3600), 'hour'] : [Math.round(s / 86_400), 'day'];
  return `${n} ${unit}${n === 1 ? '' : 's'} ${seconds >= 0 ? 'before' : 'after'}`;
}

function hostOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).host || null;
  } catch {
    return null;
  }
}

/** A button that reads as text: no box, but the browser's focus ring kept. */
const textButton: CSSProperties = {
  background: 'none',
  border: 'none',
  padding: 0,
  margin: 0,
  font: 'inherit',
  color: 'inherit',
  textAlign: 'left',
  cursor: 'pointer',
};

function Pill({ children, bg, fg }: { children: ReactNode; bg: string; fg: string }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', background: bg, color: fg, padding: '3px 9px', borderRadius: 999, fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap' }}>
      {children}
    </span>
  );
}

/** Why the selected conversion went where it did, in one or two sentences. */
export function decisionSummary(d: JourneyDecision, events: JourneyEvent[]): string {
  const event = events.find((e) => e.id === d.eventId);
  const type = event?.type ?? 'conversion';
  switch (d.status) {
    case 'corrective':
      return 'Refunds, chargebacks, disputes and failed payments are recorded for the audit trail but never attributed.';
    case 'no_identity':
      return 'This customer was never linked to a partner click or code, so nobody was credited.';
    case 'no_click':
      return 'Every touch linked to this customer is fraud-flagged or belongs to a revoked partner, so nobody was credited.';
    case 'outside_window':
      return "No touch could take this conversion (each touch's reason is below: outside its window, after the sale, or its program deleted), and no earlier conversion carries the customer, so nobody was credited.";
  }
  if (d.source === 'renewal' && d.fromEvent) {
    return `A repeat ${type}. It stays with the partner credited for the customer's first ${d.fromEvent.type} (${formatDate(d.fromEvent.ts)}), whatever they clicked since.`;
  }
  if (d.source === 'latest_conversion' && d.fromEvent) {
    return `No touch was left in the window, so the customer's latest conversion (${d.fromEvent.type}, ${formatDate(d.fromEvent.ts)}) carried it.`;
  }
  const model = d.model ? MODEL_LABEL[d.model].toLowerCase() : 'the program';
  return `Decided by the ${model} model over the ${d.candidates} partner ${d.candidates === 1 ? 'touch' : 'touches'} in the window.`;
}

export function AdminJourney() {
  const [params, setParams] = useSearchParams();
  const eventId = params.get('event');
  const customer = params.get('customer');
  const [lookup, setLookup] = useState(customer ?? '');
  const isMobile = useIsMobile();

  const path = eventId
    ? `/events/${encodeURIComponent(eventId)}/journey`
    : customer
      ? `/customers/${encodeURIComponent(customer)}/journey`
      : null;
  const { data, error, isLoading } = useQuery({
    queryKey: ['journey', path],
    queryFn: () => api<Journey>(path!),
    enabled: path !== null,
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const id = lookup.trim();
    if (id) setParams({ customer: id });
  };
  const select = (id: string) => setParams({ event: id });

  return (
    <Page
      title="Customer journey"
      subtitle="Every partner touch for one customer, in order, and who got credit for each conversion and why."
    >
      <Card>
        <form onSubmit={submit} style={{ display: 'flex', gap: 8, flexDirection: isMobile ? 'column' : 'row' }}>
          <Input
            aria-label="Customer id"
            placeholder="Customer id, as your app sends it to identify"
            value={lookup}
            onChange={(e) => setLookup(e.target.value)}
            style={{ flex: 1 }}
          />
          <Button type="submit" disabled={!lookup.trim()}>
            Look up
          </Button>
        </form>
      </Card>

      <ErrorBanner error={error} />
      {path === null ? (
        <EmptyState
          title="Look up a customer"
          hint="Or open any commission's journey from Commissions."
          icon={<RouteIcon size={28} strokeWidth={1.25} />}
        />
      ) : isLoading || !data ? (
        error ? null : <Card>Loading…</Card>
      ) : (
        <JourneyView journey={data} onSelect={select} />
      )}
    </Page>
  );
}

export function JourneyView({ journey, onSelect }: { journey: Journey; onSelect: (eventId: string) => void }) {
  const d = journey.selected;
  const verdictOf = new Map(d?.touches.map((t) => [t.clickId, t]) ?? []);
  type Row = { at: number; key: string; node: ReactNode };
  const rows: Row[] = [
    ...journey.touches.map((t) => ({ at: Date.parse(t.ts), key: `t${t.clickId}`, node: <TouchRow touch={t} verdict={verdictOf.get(t.clickId)} /> })),
    ...journey.events.map((e) => ({
      at: Date.parse(e.ts),
      key: `e${e.id}`,
      node: <EventRow event={e} selected={d?.eventId === e.id} onSelect={() => onSelect(e.id)} />,
    })),
  ].sort((a, b) => a.at - b.at || a.key.localeCompare(b.key));

  return (
    <>
      {d && <DecisionCard decision={d} events={journey.events} onSelect={onSelect} />}

      <SectionHeading>Timeline</SectionHeading>
      <p style={{ margin: '0 0 12px', fontSize: 13, color: theme.textMuted }}>
        Customer <code>{journey.userId}</code>. Only partner touches are recorded: paid search, organic and direct visits
        never reach OpenPartner, so they're gaps between these steps, not missing steps.
        {journey.truncated.touches || journey.truncated.events
          ? ' Showing the newest 200 touches and events. The decision still weighs every touch, so a credited one can be older than those shown.'
          : ''}
      </p>
      <Card padded={false}>
        {rows.length === 0 ? (
          <div style={{ padding: 16, color: theme.textDim, fontSize: 14 }}>Nothing recorded for this customer.</div>
        ) : (
          rows.map((r, i) => (
            <div key={r.key} style={{ padding: '12px 16px', borderTop: i === 0 ? 'none' : `1px solid ${theme.borderSubtle}` }}>
              {r.node}
            </div>
          ))
        )}
      </Card>
    </>
  );
}

function TouchRow({ touch, verdict }: { touch: JourneyTouch; verdict: JourneyDecision['touches'][number] | undefined }) {
  const v = verdict ? VERDICT[verdict.verdict] : null;
  const details = [
    touch.kind === 'link' ? hostOf(touch.referer) && `from ${hostOf(touch.referer)}` : null,
    touch.kind === 'link' && touch.landingUrl ? `to ${hostOf(touch.landingUrl) ?? touch.landingUrl}` : null,
    touch.utmSource ? `utm ${[touch.utmSource, touch.utmMedium, touch.utmCampaign].filter(Boolean).join(' / ')}` : null,
    touch.subId ? `sub_id ${touch.subId}` : null,
    [touch.browser, touch.device, touch.country].filter(Boolean).join(' · ') || null,
    touch.kind === 'link' ? (touch.landedAt ? 'landing reported' : 'no landing report') : null,
  ].filter(Boolean) as string[];
  return (
    <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
      <span style={{ color: theme.textDim, marginTop: 2 }}>{touch.kind === 'code' ? <Code2 size={16} /> : <MousePointerClick size={16} />}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
          <span style={{ fontWeight: 500 }}>
            <TenantLink to={`/admin/partners/${touch.partner.id}/referrals`}>{touch.partner.name ?? touch.partner.id.slice(-8)}</TenantLink>
            {touch.kind === 'code' ? <> · code <code>{touch.code}</code></> : ' · link click'}
          </span>
          {touch.flagged && <Pill bg={theme.dangerSoft} fg={theme.danger}>flagged</Pill>}
          {v && verdict && (
            <Pill bg={v.bg} fg={v.fg}>
              {v.label}
              {verdict.verdict === 'credited' && verdict.weight != null ? ` ${pct(verdict.weight)}` : ''}
            </Pill>
          )}
        </div>
        <div style={{ fontSize: 12, color: theme.textMuted, marginTop: 3, overflowWrap: 'anywhere' }}>
          {formatDate(touch.ts)}
          {touch.program.name ? ` · ${touch.program.name}` : ''}
          {verdict ? ` · ${gap(verdict.secondsBeforeEvent)} the selected event` : ''}
          {verdict?.pastWindow ? ' · kept past its window by a renewal' : ''}
          {verdict?.linkedAfterEvent ? ' · linked to the customer after it' : ''}
        </div>
        {details.length > 0 && <div style={{ fontSize: 12, color: theme.textDim, marginTop: 2, overflowWrap: 'anywhere' }}>{details.join(' · ')}</div>}
      </div>
    </div>
  );
}

function EventRow({ event, selected, onSelect }: { event: JourneyEvent; selected: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      style={{
        ...textButton,
        display: 'block',
        width: '100%',
        borderLeft: `3px solid ${selected ? theme.accent : 'transparent'}`,
        paddingLeft: 9,
        marginLeft: -12,
      }}
    >
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
        <span style={{ fontWeight: 600 }}>{event.type}</span>
        {event.value != null && <span>{money(event.value, event.currency ?? 'USD')}</span>}
        {event.corrective && <Pill bg={theme.warnSoft} fg={theme.warn}>not attributed</Pill>}
        {selected && <Pill bg={theme.accentSoft} fg={theme.accentText}>explained above</Pill>}
      </div>
      <div style={{ fontSize: 12, color: theme.textMuted, marginTop: 3 }}>
        {formatDate(event.ts)}
        {event.credited.length > 0
          ? ` · credited to ${event.credited.map((c) => `${name(c)} ${pct(c.weight)}`).join(', ')}`
          : event.corrective
            ? ''
            : ' · nobody credited'}
      </div>
    </button>
  );
}

function DecisionCard({ decision: d, events, onSelect }: { decision: JourneyDecision; events: JourneyEvent[]; onSelect: (eventId: string) => void }) {
  const event = events.find((e) => e.id === d.eventId);
  const credited = d.recorded.filter((r) => r.model === d.recorded[0]?.model);
  return (
    <>
      <SectionHeading>Who got credit, and why</SectionHeading>
      <Card>
        <div style={{ fontSize: 13, color: theme.textMuted, marginBottom: 6 }}>
          {event ? `${event.type} · ${formatDate(event.ts)}${event.value != null ? ` · ${money(event.value, event.currency ?? 'USD')}` : ''}` : d.eventId}
        </div>
        <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 6 }}>
          {credited.length > 0 ? `Credited to ${credited.map((r) => `${name(r)} (${pct(r.weight)})`).join(', ')}` : 'Nobody was credited'}
        </div>
        <p style={{ margin: 0, fontSize: 14, color: theme.text }}>
          {decisionSummary(d, events)}
          {d.fromEvent && (
            <>
              {' '}
              <button type="button" onClick={() => onSelect(d.fromEvent!.id)} style={{ ...textButton, color: theme.accentText, textDecoration: 'underline' }}>
                Show that conversion
              </button>
            </>
          )}
        </p>
        {!d.matchesRecord && (
          <p role="note" style={{ margin: '10px 0 0', padding: '8px 10px', borderRadius: 8, background: theme.warnSoft, color: theme.warn, fontSize: 13 }}>
            Today's data would credit this differently: a touch was linked to the customer, flagged or revoked after it was decided.
            The credit shown here is what was recorded and earned.
          </p>
        )}

        {credited.some((r) => r.commissions.length > 0) && (
          <div style={{ marginTop: 14 }}>
            <Table
              columns={['Partner', { label: 'Commission', align: 'right' }, 'Status']}
              rows={credited.flatMap((r) =>
                r.commissions.map((c) => [
                  <span>
                    {name(c)}
                    {c.recruiter ? <span style={{ color: theme.textDim }}> · recruiter share</span> : null}
                  </span>,
                  <span style={{ fontWeight: 500 }}>{money(c.amount, c.currency)}</span>,
                  <StatusPill status={c.status} />,
                ]),
              )}
            />
          </div>
        )}

        {d.alternatives && (
          <div style={{ marginTop: 14 }}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>Under each model, over the same touches</div>
            <Table
              columns={['Model', 'Who would get credit']}
              rows={d.alternatives.map((a) => [
                <span>
                  {MODEL_LABEL[a.model]}
                  {a.live ? <span style={{ color: theme.textDim }}> · this program's model</span> : null}
                </span>,
                <span>{a.credits.length ? a.credits.map((c) => `${name(c)} ${pct(c.weight)}`).join(', ') : 'Nobody'}</span>,
              ])}
            />
          </div>
        )}
      </Card>
    </>
  );
}
