/**
 * Creator index (openpartner-network docs/creator-index.md §6): creators
 * the Network lists from their public profiles before they join. Everything
 * lives on the Network; this page reads and writes it through the admin key.
 *
 *   - Status: how many are listed, shown to brands or hidden, the month's
 *     spend against the budget, rejections, invites.
 *   - Settings: on/off, invites on/off, budget, thresholds, the countries
 *     never indexed, the regions hidden from brands, seed queries, model.
 *   - Seed URLs, runs, and search with removal.
 *
 * Support operators can look and dry-run the invite email; changes and runs
 * need an admin.
 */

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { theme } from '../../theme.js';
import { Button, Card, ErrorBanner, Input, Label, Page, Select, Table, Textarea } from '../../ui.js';
import { friendlyPlatformError, papi, type PlatformOperator } from './lib.js';

interface IndexSettings {
  enabled: boolean;
  invitesEnabled: boolean;
  monthlyBudgetUsd: number;
  minFollowers: number;
  minPostsPer30d: number;
  refreshDays: number;
  excludedCountries: string[];
  hiddenRegions: string[];
  seedQueries: string[];
  classifierModel: string;
}

interface SettingsState {
  settings: IndexSettings;
  defaults: IndexSettings;
  classifierModels: string[];
  updatedAt: string | null;
  updatedByEmail: string | null;
  configured: Record<string, boolean>;
}

interface Stats {
  creators: { byStatus: Record<string, number>; listed: number; shownToBrands: number; hiddenFromBrands: number };
  byCountry: Array<{ country: string | null; count: number }>;
  candidates: Record<string, number>;
  rejections: Record<string, number>;
  invites: Record<string, number>;
  emailsSent30d: number;
  suppressions: Record<string, number>;
  spend: { thisMonthUsd: number; budgetUsd: number };
}

interface OpsCreator {
  id: string;
  status: string;
  name: string | null;
  headline: string | null;
  country: string | null;
  region: string | null;
  brandVisible: boolean;
  totalReach: number;
  contact: { masked: string; foundOn: string | null; verified: boolean } | null;
  emailsSent: number;
  platforms: Array<{ platform: string; handle: string | null; profileUrl: string; followerCount: number | null }>;
}

const list = (s: string) =>
  s
    .split(/[,\s]+/)
    .map((x) => x.trim())
    .filter(Boolean);

function Pill({ on, children }: { on: boolean; children: React.ReactNode }) {
  return (
    <span
      style={{
        fontSize: 11,
        fontWeight: 600,
        padding: '3px 9px',
        borderRadius: 999,
        color: on ? theme.success : theme.textMuted,
        background: on ? theme.successSoft : theme.surface2,
      }}
    >
      {children}
    </span>
  );
}

export function CreatorIndexPage({ operator }: { operator: PlatformOperator }) {
  const canWrite = operator.role === 'admin';
  const qc = useQueryClient();
  const state = useQuery({ queryKey: ['platform-creator-index'], queryFn: () => papi<SettingsState>('/platform-admin/creator-index/settings') });
  const stats = useQuery({ queryKey: ['platform-creator-index-stats'], queryFn: () => papi<Stats>('/platform-admin/creator-index/stats') });
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['platform-creator-index'] });
    qc.invalidateQueries({ queryKey: ['platform-creator-index-stats'] });
  };

  const [draft, setDraft] = useState<IndexSettings | null>(null);
  useEffect(() => {
    if (state.data && !draft) setDraft(state.data.settings);
  }, [state.data, draft]);
  const save = useMutation({
    mutationFn: (s: IndexSettings) => papi<{ settings: IndexSettings; visibilityChanged: number }>('/platform-admin/creator-index/settings', { method: 'PUT', body: s }),
    onSuccess: (r) => {
      setDraft(r.settings);
      refresh();
    },
  });

  const [seedText, setSeedText] = useState('');
  const seeds = useMutation({
    mutationFn: () => papi<Record<string, number>>('/platform-admin/creator-index/seeds', { method: 'POST', body: { urls: list(seedText) } }),
    onSuccess: () => {
      setSeedText('');
      refresh();
    },
  });
  const run = useMutation({
    mutationFn: (job: 'discover' | 'read' | 'refresh') => papi<Record<string, unknown>>(`/platform-admin/creator-index/run/${job}`, { method: 'POST' }),
    onSuccess: refresh,
  });
  const invites = useMutation({
    mutationFn: (dryRun: boolean) => papi<Record<string, unknown>>('/platform-admin/creator-index/invites/run', { method: 'POST', body: { dryRun } }),
    onSuccess: refresh,
  });

  const [q, setQ] = useState('');
  const [searchFor, setSearchFor] = useState('');
  const creators = useQuery({
    queryKey: ['platform-creator-index-creators', searchFor],
    queryFn: () => papi<{ creators: OpsCreator[] }>(`/platform-admin/creator-index/creators${searchFor ? `?q=${encodeURIComponent(searchFor)}` : ''}`),
  });
  const remove = useMutation({
    mutationFn: (id: string) => papi(`/platform-admin/creator-index/creators/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['platform-creator-index-creators'] });
      refresh();
    },
  });

  const s = stats.data;
  const configured = state.data?.configured;
  const error = save.error ?? seeds.error ?? run.error ?? invites.error ?? remove.error;

  return (
    <Page
      title="Creator index"
      subtitle="Creators the Network lists from their public profiles before they join, for brands on Flex and Enterprise to invite. Nothing runs until it's switched on with a budget."
    >
      <ErrorBanner error={error ? friendlyPlatformError(error) : state.error ?? stats.error} />
      {!state.data || !draft ? (
        <Card>Loading…</Card>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <Card>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
              <span style={{ fontSize: 15, fontWeight: 600, marginRight: 4 }}>Status</span>
              <Pill on={state.data.settings.enabled}>{state.data.settings.enabled ? 'indexing on' : 'indexing off'}</Pill>
              <Pill on={state.data.settings.invitesEnabled}>{state.data.settings.invitesEnabled ? 'invite emails on' : 'invite emails off'}</Pill>
              {configured && (
                <span style={{ fontSize: 12, color: theme.textMuted }}>
                  Sources:{' '}
                  {Object.entries(configured)
                    .map(([k, on]) => `${k} ${on ? '✓' : '✗'}`)
                    .join(' · ')}
                </span>
              )}
            </div>
            {s && (
              <div className="op-grid-collapse" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, fontSize: 13 }}>
                <div>
                  <Label>Listed</Label>
                  <div style={{ fontSize: 20, fontWeight: 600 }}>{s.creators.listed.toLocaleString()}</div>
                  <div style={{ color: theme.textMuted }}>
                    {s.creators.shownToBrands.toLocaleString()} shown · {s.creators.hiddenFromBrands.toLocaleString()} hidden
                  </div>
                </div>
                <div>
                  <Label>Spend this month</Label>
                  <div style={{ fontSize: 20, fontWeight: 600 }}>${s.spend.thisMonthUsd.toFixed(2)}</div>
                  <div style={{ color: theme.textMuted }}>of ${s.spend.budgetUsd} budget</div>
                </div>
                <div>
                  <Label>Queue</Label>
                  <div style={{ color: theme.textMuted }}>
                    {Object.entries(s.candidates).map(([k, v]) => `${k} ${v}`).join(' · ') || '—'}
                  </div>
                </div>
                <div>
                  <Label>Invites</Label>
                  <div style={{ color: theme.textMuted }}>
                    {Object.entries(s.invites).map(([k, v]) => `${k} ${v}`).join(' · ') || '—'}
                  </div>
                  <div style={{ color: theme.textMuted }}>{s.emailsSent30d} emails in 30 days</div>
                </div>
              </div>
            )}
            {s && Object.keys(s.rejections).length > 0 && (
              <div style={{ marginTop: 12, fontSize: 12, color: theme.textMuted }}>
                Rejected: {Object.entries(s.rejections).map(([k, v]) => `${k.replace(/_/g, ' ')} ${v}`).join(' · ')}
              </div>
            )}
          </Card>

          <Card>
            <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 12 }}>Settings</div>
            <div className="op-grid-collapse" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 14 }}>
              <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 14 }}>
                <input type="checkbox" checked={draft.enabled} disabled={!canWrite} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} />
                Indexing on
              </label>
              <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 14 }}>
                <input type="checkbox" checked={draft.invitesEnabled} disabled={!canWrite} onChange={(e) => setDraft({ ...draft, invitesEnabled: e.target.checked })} />
                Invite emails on
              </label>
              <div />
              <div>
                <Label>Monthly budget (USD)</Label>
                <Input type="number" min={0} value={draft.monthlyBudgetUsd} disabled={!canWrite} onChange={(e) => setDraft({ ...draft, monthlyBudgetUsd: Math.max(0, Math.round(Number(e.target.value) || 0)) })} />
              </div>
              <div>
                <Label>Min. followers</Label>
                <Input type="number" min={0} value={draft.minFollowers} disabled={!canWrite} onChange={(e) => setDraft({ ...draft, minFollowers: Math.max(0, Math.round(Number(e.target.value) || 0)) })} />
              </div>
              <div>
                <Label>Min. posts in 30 days</Label>
                <Input type="number" min={0} value={draft.minPostsPer30d} disabled={!canWrite} onChange={(e) => setDraft({ ...draft, minPostsPer30d: Math.max(0, Math.round(Number(e.target.value) || 0)) })} />
              </div>
              <div>
                <Label>Refresh every (days)</Label>
                <Input type="number" min={7} max={90} value={draft.refreshDays} disabled={!canWrite} onChange={(e) => setDraft({ ...draft, refreshDays: Math.min(90, Math.max(7, Math.round(Number(e.target.value) || 30))) })} />
              </div>
              <div>
                <Label>Classifier model</Label>
                <Select value={draft.classifierModel} disabled={!canWrite} onChange={(e) => setDraft({ ...draft, classifierModel: e.target.value })}>
                  {state.data.classifierModels.map((m) => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </Select>
              </div>
            </div>
            <div className="op-grid-collapse" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginTop: 14 }}>
              <div>
                <Label>Never indexed (countries)</Label>
                <Textarea rows={3} value={draft.excludedCountries.join(', ')} disabled={!canWrite} onChange={(e) => setDraft({ ...draft, excludedCountries: list(e.target.value).map((c) => c.toUpperCase()) })} />
              </div>
              <div>
                <Label>Hidden from brands until they claim (regions)</Label>
                <Textarea rows={3} value={draft.hiddenRegions.join(', ')} disabled={!canWrite} onChange={(e) => setDraft({ ...draft, hiddenRegions: list(e.target.value).map((c) => c.toUpperCase()) })} />
              </div>
            </div>
            <div style={{ marginTop: 14 }}>
              <Label>Seed queries (one per line; topics, never people)</Label>
              <Textarea
                rows={4}
                value={draft.seedQueries.join('\n')}
                disabled={!canWrite}
                onChange={(e) => setDraft({ ...draft, seedQueries: e.target.value.split('\n').map((x) => x.trim()).filter(Boolean) })}
              />
            </div>
            {canWrite && (
              <div style={{ display: 'flex', gap: 8, marginTop: 14, alignItems: 'center', flexWrap: 'wrap' }}>
                <Button onClick={() => save.mutate(draft)} disabled={save.isPending}>{save.isPending ? 'Saving…' : 'Save settings'}</Button>
                <Button variant="secondary" onClick={() => setDraft(state.data!.settings)}>Discard changes</Button>
                {save.data && <span style={{ fontSize: 12, color: theme.textMuted }}>Saved. {save.data.visibilityChanged} listings changed visibility.</span>}
              </div>
            )}
            {state.data.updatedByEmail && (
              <div style={{ fontSize: 12, color: theme.textDim, marginTop: 10 }}>
                Last changed by {state.data.updatedByEmail}
                {state.data.updatedAt ? ` on ${new Date(state.data.updatedAt).toLocaleString()}` : ''}
              </div>
            )}
          </Card>

          <Card>
            <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 12 }}>Runs</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {canWrite && (
                <>
                  <Button variant="secondary" onClick={() => run.mutate('discover')} disabled={run.isPending}>Discover now</Button>
                  <Button variant="secondary" onClick={() => run.mutate('read')} disabled={run.isPending}>Read queue now</Button>
                  <Button variant="secondary" onClick={() => run.mutate('refresh')} disabled={run.isPending}>Refresh now</Button>
                </>
              )}
              <Button variant="secondary" onClick={() => invites.mutate(true)} disabled={invites.isPending}>Preview invite email run</Button>
              {canWrite && <Button onClick={() => invites.mutate(false)} disabled={invites.isPending}>Send due invite emails</Button>}
            </div>
            {(run.data || invites.data) && (
              <pre style={{ marginTop: 12, fontSize: 12, background: theme.surface2, padding: 10, borderRadius: theme.radiusSm, overflowX: 'auto' }}>
                {JSON.stringify(invites.data ?? run.data, null, 2)}
              </pre>
            )}
            {canWrite && (
              <div style={{ marginTop: 16 }}>
                <Label>Queue profile URLs (LinkedIn, X, YouTube)</Label>
                <Textarea rows={3} value={seedText} onChange={(e) => setSeedText(e.target.value)} placeholder="https://www.linkedin.com/in/…" />
                <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'center' }}>
                  <Button variant="secondary" onClick={() => seeds.mutate()} disabled={!seedText.trim() || seeds.isPending}>Queue</Button>
                  {seeds.data && (
                    <span style={{ fontSize: 12, color: theme.textMuted }}>
                      {Object.entries(seeds.data).map(([k, v]) => `${k} ${v}`).join(' · ')}
                    </span>
                  )}
                </div>
              </div>
            )}
          </Card>

          <Card>
            <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 12 }}>Listed creators</div>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                setSearchFor(q.trim());
              }}
              style={{ display: 'flex', gap: 8, marginBottom: 12 }}
            >
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name, headline, handle or profile URL" />
              <Button type="submit" variant="secondary">Search</Button>
            </form>
            <Table
              columns={['Creator', 'Where', 'Reach', 'Address', 'Status', '']}
              rows={(creators.data?.creators ?? []).map((c) => [
                <div key="n">
                  <div style={{ fontWeight: 500 }}>{c.name ?? '—'}</div>
                  <div style={{ fontSize: 12, color: theme.textMuted }}>
                    {c.platforms.map((p) => (
                      <a key={p.profileUrl} href={p.profileUrl} target="_blank" rel="noreferrer noopener" style={{ color: theme.textMuted, marginRight: 8 }}>
                        {p.platform}
                      </a>
                    ))}
                  </div>
                </div>,
                `${c.country ?? '—'}${c.region ? ` (${c.region})` : ''}${c.brandVisible ? '' : ' · hidden'}`,
                c.totalReach.toLocaleString(),
                c.contact ? `${c.contact.masked}${c.contact.verified ? '' : ' (unverified)'}` : '—',
                `${c.status}${c.emailsSent ? ` · ${c.emailsSent} sent` : ''}`,
                canWrite && c.status !== 'claimed' ? (
                  <Button
                    key="r"
                    variant="secondary"
                    onClick={() => {
                      if (window.confirm(`Remove ${c.name ?? 'this creator'} and never list them again?`)) remove.mutate(c.id);
                    }}
                  >
                    Remove
                  </Button>
                ) : (
                  ''
                ),
              ])}
            />
          </Card>
        </div>
      )}
    </Page>
  );
}
