/**
 * /platform/rates — the CPM table behind creators' suggested rates and the
 * public rate calculator, and the calculator's lookup limits (the Network's
 * docs/rate-suggestions.md §8). Every number is USD per 1,000 of the
 * platform's basis, for the general niche.
 */
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { theme } from '../../theme.js';
import { Button, Card, ErrorBanner, Input, Label, Page, Select, Table, formatDate } from '../../ui.js';
import { friendlyPlatformError, papi, type PlatformOperator } from './lib.js';

const BASES = ['views', 'followers', 'subscribers', 'listeners'] as const;
type Basis = (typeof BASES)[number];

interface FormatRate {
  label: string;
  low: number;
  high: number;
}
interface PlatformRates {
  basis: Basis;
  niches?: Record<string, { low: number; high: number }>;
  formats: Record<string, FormatRate>;
}
export interface RatesSettings {
  minAudience: number;
  taper: Record<string, Array<{ above: number; weight: number }>>;
  niches: { b2b: { low: number; high: number }; entertainment: { low: number; high: number } };
  platforms: Record<string, PlatformRates>;
  calculator: { dailyBudgetUsd: number; monthlyBudgetUsd: number; lookupsPerIpPerDay: number; youtubeLookupsPerDay: number };
}
export interface RatesState {
  settings: RatesSettings;
  defaults: RatesSettings;
  updatedAt: string | null;
  updatedByEmail: string | null;
  spend: { todayUsd: number; monthUsd: number; youtubeToday: number };
}

const RATES_KEY = ['platform-rates'];
const KEY = /^[a-z][a-z0-9_]{0,39}$/;
const muted = { fontSize: 13, color: theme.textMuted, lineHeight: 1.5 } as const;
const sectionTitle = { fontSize: 15, fontWeight: 600 } as const;

/** "$10", "$3.50", "$0.25". */
const usd = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 })}`;

/** A form field's text as a number, or null when it isn't one in range. */
function numberIn(text: string, min: number, max: number): number | null {
  if (text.trim() === '') return null;
  const n = Number(text);
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
}

interface Row {
  platform: string;
  basis: Basis;
  format: string;
  label: string;
  low: string;
  high: string;
}

function rowsOf(s: RatesSettings): Row[] {
  return Object.entries(s.platforms).flatMap(([platform, p]) =>
    Object.entries(p.formats).map(([format, f]) => ({ platform, basis: p.basis, format, label: f.label, low: String(f.low), high: String(f.high) })),
  );
}

function rowProblem(r: Row): string | null {
  const low = numberIn(r.low, 0, 10_000);
  const high = numberIn(r.high, 0, 10_000);
  if (!r.label.trim()) return 'needs a label';
  if (low === null || high === null) return 'needs low and high between 0 and 10,000';
  if (high < low) return 'high is below low';
  return null;
}

interface Draft {
  rows: Row[];
  minAudience: string;
  b2bLow: string;
  b2bHigh: string;
  entLow: string;
  entHigh: string;
  dailyBudgetUsd: string;
  monthlyBudgetUsd: string;
  lookupsPerIpPerDay: string;
  youtubeLookupsPerDay: string;
}

function draftOf(s: RatesSettings): Draft {
  return {
    rows: rowsOf(s),
    minAudience: String(s.minAudience),
    b2bLow: String(s.niches.b2b.low),
    b2bHigh: String(s.niches.b2b.high),
    entLow: String(s.niches.entertainment.low),
    entHigh: String(s.niches.entertainment.high),
    dailyBudgetUsd: String(s.calculator.dailyBudgetUsd),
    monthlyBudgetUsd: String(s.calculator.monthlyBudgetUsd),
    lookupsPerIpPerDay: String(s.calculator.lookupsPerIpPerDay),
    youtubeLookupsPerDay: String(s.calculator.youtubeLookupsPerDay),
  };
}

/** The draft as settings, keeping what the page doesn't edit (the taper,
 *  a platform's own niche multipliers), or a list of what's wrong. */
function settingsOf(d: Draft, base: RatesSettings): { settings: RatesSettings } | { problems: string[] } {
  const problems: string[] = [];
  d.rows.forEach((r) => {
    const p = rowProblem(r);
    if (p) problems.push(`${r.platform} ${r.format}: ${p}`);
  });
  // The Network keeps at most 12 formats a platform and 40 platforms, and
  // would drop the rest without a word.
  const perPlatform = new Map<string, number>();
  for (const r of d.rows) perPlatform.set(r.platform, (perPlatform.get(r.platform) ?? 0) + 1);
  for (const [platform, n] of perPlatform) if (n > 12) problems.push(`${platform} has ${n} formats; 12 at most`);
  if (perPlatform.size > 40) problems.push(`${perPlatform.size} platforms; 40 at most`);
  const field = (name: string, text: string, min: number, max: number) => {
    const n = numberIn(text, min, max);
    if (n === null) problems.push(`${name} must be between ${min} and ${max}`);
    return n ?? 0;
  };
  const minAudience = Math.round(field('Minimum audience', d.minAudience, 1, 1_000_000));
  const b2b = { low: field('B2B low', d.b2bLow, 0.1, 10), high: field('B2B high', d.b2bHigh, 0.1, 10) };
  const entertainment = { low: field('Entertainment low', d.entLow, 0.1, 10), high: field('Entertainment high', d.entHigh, 0.1, 10) };
  // The Network refuses an inverted range rather than guess.
  if (b2b.high < b2b.low) problems.push('B2B high is below low');
  if (entertainment.high < entertainment.low) problems.push('Entertainment high is below low');
  const calculator = {
    dailyBudgetUsd: field('Daily budget', d.dailyBudgetUsd, 0, 1_000),
    monthlyBudgetUsd: field('Monthly budget', d.monthlyBudgetUsd, 0, 10_000),
    lookupsPerIpPerDay: Math.round(field('Lookups per address', d.lookupsPerIpPerDay, 0, 1_000)),
    youtubeLookupsPerDay: Math.round(field('YouTube lookups', d.youtubeLookupsPerDay, 0, 5_000)),
  };
  if (problems.length) return { problems };

  const platforms: Record<string, PlatformRates> = {};
  for (const r of d.rows) {
    const p = (platforms[r.platform] ??= {
      basis: r.basis,
      ...(base.platforms[r.platform]?.niches ? { niches: base.platforms[r.platform]!.niches } : {}),
      formats: {},
    });
    p.formats[r.format] = { label: r.label.trim(), low: Number(r.low), high: Number(r.high) };
  }
  return { settings: { ...base, minAudience, niches: { b2b, entertainment }, platforms, calculator } };
}

export function RatesPage({ operator }: { operator: PlatformOperator }) {
  const canWrite = operator.role === 'admin';
  const qc = useQueryClient();
  const state = useQuery({ queryKey: RATES_KEY, queryFn: () => papi<RatesState>('/platform-admin/rates') });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [adding, setAdding] = useState<Row>({ platform: '', basis: 'followers', format: '', label: '', low: '', high: '' });

  useEffect(() => {
    if (state.data && draft === null) setDraft(draftOf(state.data.settings));
  }, [state.data, draft]);

  const save = useMutation({
    mutationFn: (settings: RatesSettings) => papi<RatesState>('/platform-admin/rates', { method: 'PUT', body: { settings } }),
    onSuccess: (saved) => {
      qc.setQueryData(RATES_KEY, saved);
      setDraft(draftOf(saved.settings));
    },
  });

  if (!state.data || !draft) {
    return (
      <Page title="Rates">
        <ErrorBanner error={state.error} />
        <Card>Loading…</Card>
      </Page>
    );
  }
  const data = state.data;
  const built = settingsOf(draft, data.settings);
  const dirty = JSON.stringify(draft) !== JSON.stringify(draftOf(data.settings));
  const set = (patch: Partial<Draft>) => setDraft({ ...draft, ...patch });
  const setRow = (i: number, patch: Partial<Row>) => set({ rows: draft.rows.map((r, j) => (j === i ? { ...r, ...patch } : r)) });
  const addKeyProblem =
    !KEY.test(adding.platform) || !KEY.test(adding.format)
      ? 'Platform and format are lower-case keys, like youtube and integration.'
      : draft.rows.some((r) => r.platform === adding.platform && r.format === adding.format)
        ? 'That platform already prices that format.'
        : (rowProblem(adding) ?? null);
  // A platform keeps the basis it has.
  const basisOf = (platform: string) => draft.rows.find((r) => r.platform === platform)?.basis;

  const c = data.settings.calculator;
  return (
    <Page
      title="Rates"
      subtitle="USD per 1,000 of each platform's audience number, for the general niche. Behind creators' suggested rates and the public rate calculator."
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <ErrorBanner error={save.error ? friendlyPlatformError(save.error) : null} />
        <Card>
          <div style={sectionTitle}>Calculator lookups</div>
          <div style={{ ...muted, marginTop: 6 }} data-testid="rates-spend">
            Today {usd(data.spend.todayUsd)} of {usd(c.dailyBudgetUsd)} · This month {usd(data.spend.monthUsd)} of {usd(c.monthlyBudgetUsd)} · YouTube{' '}
            {data.spend.youtubeToday} of {c.youtubeLookupsPerDay} today
          </div>
          <div className="op-grid-collapse" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginTop: 12 }}>
            <div>
              <Label>Daily budget ($)</Label>
              <Input aria-label="Daily budget" value={draft.dailyBudgetUsd} disabled={!canWrite} onChange={(e) => set({ dailyBudgetUsd: e.target.value })} />
            </div>
            <div>
              <Label>Monthly budget ($)</Label>
              <Input aria-label="Monthly budget" value={draft.monthlyBudgetUsd} disabled={!canWrite} onChange={(e) => set({ monthlyBudgetUsd: e.target.value })} />
            </div>
            <div>
              <Label>Lookups per address a day</Label>
              <Input aria-label="Lookups per address a day" value={draft.lookupsPerIpPerDay} disabled={!canWrite} onChange={(e) => set({ lookupsPerIpPerDay: e.target.value })} />
            </div>
            <div>
              <Label>YouTube lookups a day</Label>
              <Input aria-label="YouTube lookups a day" value={draft.youtubeLookupsPerDay} disabled={!canWrite} onChange={(e) => set({ youtubeLookupsPerDay: e.target.value })} />
            </div>
          </div>
        </Card>

        <Card>
          <div style={sectionTitle}>Niches and minimum</div>
          <div className="op-grid-collapse" style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 12, marginTop: 12 }}>
            <div>
              <Label>Minimum audience</Label>
              <Input aria-label="Minimum audience" value={draft.minAudience} disabled={!canWrite} onChange={(e) => set({ minAudience: e.target.value })} />
            </div>
            <div>
              <Label>B2B ×low</Label>
              <Input aria-label="B2B low" value={draft.b2bLow} disabled={!canWrite} onChange={(e) => set({ b2bLow: e.target.value })} />
            </div>
            <div>
              <Label>B2B ×high</Label>
              <Input aria-label="B2B high" value={draft.b2bHigh} disabled={!canWrite} onChange={(e) => set({ b2bHigh: e.target.value })} />
            </div>
            <div>
              <Label>Entertainment ×low</Label>
              <Input aria-label="Entertainment low" value={draft.entLow} disabled={!canWrite} onChange={(e) => set({ entLow: e.target.value })} />
            </div>
            <div>
              <Label>Entertainment ×high</Label>
              <Input aria-label="Entertainment high" value={draft.entHigh} disabled={!canWrite} onChange={(e) => set({ entHigh: e.target.value })} />
            </div>
          </div>
        </Card>

        <Card>
          <div style={sectionTitle}>Formats</div>
          <div style={{ marginTop: 12 }}>
            <Table
              resizeKey="ops.rates.formats"
              columns={['Platform', 'Per 1,000', 'Format', 'Label', { label: 'Low', align: 'right' }, { label: 'High', align: 'right' }, '']}
              empty="No formats: no estimates anywhere."
              rows={draft.rows.map((r, i) => [
                r.platform,
                r.basis,
                r.format,
                <Input key="l" aria-label={`${r.platform} ${r.format} label`} value={r.label} maxLength={60} disabled={!canWrite} onChange={(e) => setRow(i, { label: e.target.value })} />,
                <Input key="lo" aria-label={`${r.platform} ${r.format} low`} value={r.low} disabled={!canWrite} onChange={(e) => setRow(i, { low: e.target.value })} style={{ width: 80, textAlign: 'right' }} />,
                <Input key="hi" aria-label={`${r.platform} ${r.format} high`} value={r.high} disabled={!canWrite} onChange={(e) => setRow(i, { high: e.target.value })} style={{ width: 80, textAlign: 'right' }} />,
                canWrite ? (
                  <Button key="x" size="sm" variant="ghost" onClick={() => set({ rows: draft.rows.filter((_, j) => j !== i) })}>
                    Remove
                  </Button>
                ) : null,
              ])}
            />
          </div>
          {canWrite && (
            <div className="op-grid-collapse" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1.4fr 0.7fr 0.7fr auto', gap: 8, marginTop: 12, alignItems: 'end' }}>
              <div>
                <Label>Platform</Label>
                <Input aria-label="New platform" value={adding.platform} placeholder="youtube" onChange={(e) => setAdding({ ...adding, platform: e.target.value.trim().toLowerCase(), basis: basisOf(e.target.value.trim().toLowerCase()) ?? adding.basis })} />
              </div>
              <div>
                <Label>Per 1,000</Label>
                <Select aria-label="New basis" value={basisOf(adding.platform) ?? adding.basis} disabled={!!basisOf(adding.platform)} onChange={(e) => setAdding({ ...adding, basis: e.target.value as Basis })}>
                  {BASES.map((b) => (
                    <option key={b} value={b}>{b}</option>
                  ))}
                </Select>
              </div>
              <div>
                <Label>Format</Label>
                <Input aria-label="New format" value={adding.format} placeholder="integration" onChange={(e) => setAdding({ ...adding, format: e.target.value.trim().toLowerCase() })} />
              </div>
              <div>
                <Label>Label</Label>
                <Input aria-label="New label" value={adding.label} maxLength={60} onChange={(e) => setAdding({ ...adding, label: e.target.value })} />
              </div>
              <div>
                <Label>Low</Label>
                <Input aria-label="New low" value={adding.low} onChange={(e) => setAdding({ ...adding, low: e.target.value })} />
              </div>
              <div>
                <Label>High</Label>
                <Input aria-label="New high" value={adding.high} onChange={(e) => setAdding({ ...adding, high: e.target.value })} />
              </div>
              <Button
                size="sm"
                variant="secondary"
                disabled={!!addKeyProblem}
                onClick={() => {
                  set({ rows: [...draft.rows, { ...adding, basis: basisOf(adding.platform) ?? adding.basis }] });
                  setAdding({ platform: '', basis: 'followers', format: '', label: '', low: '', high: '' });
                }}
              >
                Add
              </Button>
            </div>
          )}
          {canWrite && addKeyProblem && (adding.platform || adding.format || adding.label) && (
            <div style={{ ...muted, marginTop: 6 }}>{addKeyProblem}</div>
          )}
        </Card>

        {'problems' in built && dirty && (
          <div role="alert" style={{ fontSize: 13, color: theme.danger }}>
            {built.problems.join('; ')}.
          </div>
        )}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {canWrite && (
            <>
              <Button disabled={!dirty || 'problems' in built || save.isPending} onClick={() => 'settings' in built && save.mutate(built.settings)}>
                {save.isPending ? 'Saving…' : 'Save'}
              </Button>
              <Button variant="secondary" disabled={!dirty} onClick={() => setDraft(draftOf(data.settings))}>
                Discard changes
              </Button>
              <Button variant="ghost" onClick={() => setDraft(draftOf(data.defaults))}>
                Load defaults
              </Button>
            </>
          )}
          {data.updatedAt && (
            <span style={muted}>
              Last saved {formatDate(data.updatedAt)}
              {data.updatedByEmail ? ` by ${data.updatedByEmail}` : ''}
            </span>
          )}
        </div>
      </div>
    </Page>
  );
}
