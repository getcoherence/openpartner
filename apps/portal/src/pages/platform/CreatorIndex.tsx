/**
 * Creator index (openpartner-network docs/creator-index.md §6): creators
 * the Network lists from their public profiles before they join. Everything
 * lives on the Network; this page reads and writes it through the admin key.
 *
 *   - Status: how many are listed, shown to brands or hidden, the month's
 *     spend against the budget, rejections, invites.
 *   - Settings: on/off, invites on/off, budget, thresholds, the countries
 *     never indexed, the regions hidden from brands, seed queries and where
 *     to search them, whether to keep only creators who take partnerships,
 *     model.
 *   - Seed URLs, runs, and search with removal.
 *
 * Support operators can look and dry-run the invite email; changes and runs
 * need an admin.
 */

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { theme } from '../../theme.js';
import { Button, Card, ErrorBanner, Input, Label, Page, Select, Table, Textarea, formatDate } from '../../ui.js';
import { friendlyPlatformError, papi, type PlatformOperator } from './lib.js';
import { brandSignalLabel, shortUrl, type PartnershipSignal } from '../../lib/partnership-signals.js';

type DiscoverySource = 'storefronts' | 'sponsorPages' | 'people';

/** Where seed queries are searched, as ops read it. */
const DISCOVERY_SOURCES: Array<{ key: DiscoverySource; label: string }> = [
  { key: 'storefronts', label: 'Sponsorship storefronts' },
  { key: 'sponsorPages', label: 'Creators’ sponsor and media-kit pages' },
  { key: 'people', label: 'Anyone who posts about the topic' },
];

/** Until the Network sends its own. */
const SOURCE_DEFAULTS: Record<DiscoverySource, boolean> = { storefronts: true, sponsorPages: true, people: false };

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
  discoverySources?: Record<DiscoverySource, boolean>;
  requirePartnershipSignal?: boolean;
  /** Profiles read at once (1–20). */
  readConcurrency?: number;
  /** Paid address lookups when a creator published none. */
  contactEnrichment?: { creatorData: boolean; ownDomain: boolean };
  classifierModel: string;
}

type IndexJob = 'discover' | 'read' | 'refresh';

interface IndexRun {
  startedAt: string;
  /** Null while it's running. */
  finishedAt: string | null;
  result: Record<string, unknown> | null;
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
  creators: {
    byStatus: Record<string, number>;
    listed: number;
    /** Listed in the last 24 hours and 7 days. */
    listedLast24h?: number;
    listedLast7d?: number;
    shownToBrands: number;
    hiddenFromBrands: number;
    /** Of the hidden: by region, and for want of an address. */
    hiddenByRegion?: number;
    withEmail?: number;
    withoutEmail?: number;
    openToPartnerships?: number;
  };
  byCountry: Array<{ country: string | null; count: number }>;
  candidates: Record<string, number>;
  rejections: Record<string, number>;
  invites: Record<string, number>;
  emailsSent30d: number;
  suppressions: Record<string, number>;
  spend: { thisMonthUsd: number; budgetUsd: number };
  /** Each job's latest run. */
  runs?: Partial<Record<IndexJob, IndexRun>>;
}

/** Why a run stopped or set a platform aside, in ops' words. */
const RUN_REASONS: Record<string, string> = {
  budget: 'this month’s budget is spent',
  youtube_quota: 'the YouTube API quota is used up',
  youtube_api_disabled: 'the YouTube Data API isn’t enabled for the key',
  youtube_key_restricted: 'the YouTube key’s restrictions refuse the Network',
  youtube_not_configured: 'no YouTube key is set',
  youtube_403: 'YouTube refused the key',
};
const reasonText = (r: string) => RUN_REASONS[r] ?? r.replace(/_/g, ' ');

const JOB_LABEL: Record<IndexJob, string> = { discover: 'Discover', read: 'Read', refresh: 'Refresh' };

const PLATFORM_NAME: Record<string, string> = { linkedin: 'LinkedIn', twitter: 'X', youtube: 'YouTube', substack: 'Substack', newsletter: 'Newsletter' };

/** Where an address came from, for ops: a page, or one of the lookups. */
function contactFrom(source: string): string {
  if (source === 'via:creator-data') return 'via creator-data lookup';
  if (source.startsWith('via:own-domain:')) return `via work-email lookup (${source.slice('via:own-domain:'.length)})`;
  return shortUrl(source);
}

/** What a finished run did, in one line. */
function runSummary(job: IndexJob, r: Record<string, unknown> | null): string {
  if (!r) return '';
  if (typeof r.error === 'string') return `failed: ${r.error}`;
  if (r.ran === false) return 'didn’t run (indexing is off, or there’s nothing to search)';
  const n = (k: string) => (typeof r[k] === 'number' ? (r[k] as number) : 0);
  const parts =
    job === 'discover'
      ? [
          `${n('searches')} searches`,
          n('deeper') ? `${n('deeper')} of them deeper` : '',
          `${n('found')} found`,
          `${n('queued')} new`,
          n('recent') ? `${n('recent')} seed searches made this month` : '',
        ]
      : job === 'read'
        ? [`${n('indexed')} listed`, `${n('rejected')} turned down`, `${n('expanded')} storefronts and pages opened`, n('retried') ? `${n('retried')} to retry` : '', n('deferred') ? `${n('deferred')} waiting` : '', n('failed') ? `${n('failed')} failed` : '']
        : [`${n('refreshed')} refreshed`, `${n('deleted')} removed`, n('deferred') ? `${n('deferred')} waiting` : '', n('errors') ? `${n('errors')} errors` : ''];
  return parts.filter(Boolean).join(' · ');
}

function RunLine({ job, run }: { job: IndexJob; run: IndexRun | undefined }) {
  if (!run) return null;
  const running = !run.finishedAt;
  const r = run.result;
  const skipped = r && typeof r.skipped === 'object' && r.skipped ? Object.entries(r.skipped as Record<string, string>) : [];
  return (
    <div style={{ fontSize: 13, lineHeight: 1.5 }}>
      <strong>{JOB_LABEL[job]}</strong>{' '}
      <span style={{ color: theme.textMuted }}>
        {running
          ? `running since ${formatDate(run.startedAt, { relative: true })}…`
          : `${formatDate(run.finishedAt, { relative: true })}: ${runSummary(job, r)}`}
      </span>
      {!running && typeof r?.stoppedBy === 'string' && <div style={{ color: theme.danger }}>Stopped early: {reasonText(r.stoppedBy)}.</div>}
      {skipped.map(([platform, why]) => (
        <div key={platform} style={{ color: theme.danger }}>
          {platform === 'youtube' ? 'YouTube' : platform} set aside: {reasonText(why)}. Those profiles are tried again in an hour.
        </div>
      ))}
      {!running && job === 'discover' && Array.isArray(r?.related) && r.related.length > 0 && (
        <div style={{ color: theme.textMuted }}>Related queries searched: {(r.related as string[]).join(' · ')}</div>
      )}
      {!running && job === 'discover' && r?.ran === true && r.searches === 0 && !r.stoppedBy && (
        <div style={{ color: theme.textMuted }}>Nothing left to search on these topics this month. Add new seed queries to find more.</div>
      )}
      {typeof r?.youtubeApi === 'string' && (
        <div style={{ color: theme.textMuted }}>YouTube read through the backup source: {reasonText(r.youtubeApi)}.</div>
      )}
    </div>
  );
}

interface OpsCreator {
  id: string;
  status: string;
  name: string | null;
  headline: string | null;
  country: string | null;
  region: string | null;
  /** What the country was read from: the location as the channel gives it. */
  location?: { text: string; from: string | null } | null;
  brandVisible: boolean;
  totalReach: number;
  contact: { masked: string; foundOn: string | null; verified: boolean } | null;
  emailsSent: number;
  /** When they were listed. */
  listedAt?: string;
  platforms: Array<{ platform: string; handle: string | null; profileUrl: string; followerCount: number | null }>;
  /** With the page each was read from. */
  partnershipSignals?: PartnershipSignal[];
}

/** Listed in the last 24 hours. */
const isNew = (at: string) => Date.now() - Date.parse(at) < 86_400_000;

const list = (s: string) =>
  s
    .split(/[,\s]+/)
    .map((x) => x.trim())
    .filter(Boolean);

const codesIn = (s: string) => list(s).map((c) => c.toUpperCase());
const linesIn = (s: string) =>
  s
    .split('\n')
    .map((x) => x.trim())
    .filter(Boolean);

/** A textarea for a list. It keeps the text as typed and hands back the
 *  parsed list: showing the list joined again would drop a separator the
 *  moment it's typed (a new line, a comma, a space at the end). Mounted
 *  afresh, with a new key, when the settings are saved or discarded. */
function ListTextarea({
  value,
  parse,
  join,
  rows,
  disabled,
  onChange,
}: {
  value: string[];
  parse: (s: string) => string[];
  join: string;
  rows: number;
  disabled: boolean;
  onChange: (v: string[]) => void;
}) {
  const [text, setText] = useState(() => value.join(join));
  return (
    <Textarea
      rows={rows}
      value={text}
      disabled={disabled}
      onChange={(e) => {
        setText(e.target.value);
        onChange(parse(e.target.value));
      }}
    />
  );
}

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
  // While a run is going, and for a little while after one is started (it
  // notes itself a moment later), the counts and the list refresh themselves.
  const [watchUntil, setWatchUntil] = useState(0);
  const poll = (data: Stats | undefined) =>
    Object.values(data?.runs ?? {}).some((r) => r && !r.finishedAt) || Date.now() < watchUntil ? 4_000 : false;
  const stats = useQuery({
    queryKey: ['platform-creator-index-stats'],
    queryFn: () => papi<Stats>('/platform-admin/creator-index/stats'),
    refetchInterval: (query) => poll(query.state.data),
  });
  const watching = poll(stats.data) !== false;
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['platform-creator-index'] });
    qc.invalidateQueries({ queryKey: ['platform-creator-index-stats'] });
  };

  const [draft, setDraft] = useState<IndexSettings | null>(null);
  // Bumped when the draft is replaced, so the list boxes show it afresh.
  const [listsKey, setListsKey] = useState(0);
  useEffect(() => {
    if (state.data && !draft) setDraft(state.data.settings);
  }, [state.data, draft]);
  const replaceDraft = (s: IndexSettings) => {
    setDraft(s);
    setListsKey((k) => k + 1);
  };
  const save = useMutation({
    mutationFn: (s: IndexSettings) => papi<{ settings: IndexSettings; visibilityChanged: number }>('/platform-admin/creator-index/settings', { method: 'PUT', body: s }),
    onSuccess: (r) => {
      replaceDraft(r.settings);
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
  // Starts the job on the Network, which runs it in the background.
  const run = useMutation({
    mutationFn: (job: IndexJob) => papi<Record<string, unknown>>(`/platform-admin/creator-index/run/${job}`, { method: 'POST' }),
    onSuccess: () => {
      setWatchUntil(Date.now() + 20_000);
      refresh();
    },
  });
  const invites = useMutation({
    mutationFn: (dryRun: boolean) => papi<Record<string, unknown>>('/platform-admin/creator-index/invites/run', { method: 'POST', body: { dryRun } }),
    onSuccess: refresh,
  });

  const [q, setQ] = useState('');
  const [searchFor, setSearchFor] = useState('');
  const creators = useQuery({
    queryKey: ['platform-creator-index-creators', searchFor],
    queryFn: () => papi<{ creators: OpsCreator[]; total?: number }>(`/platform-admin/creator-index/creators${searchFor ? `?q=${encodeURIComponent(searchFor)}` : ''}`),
    refetchInterval: watching ? 4_000 : false,
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
                  {s.creators.listedLast24h != null && (
                    <div style={{ color: s.creators.listedLast24h > 0 ? theme.success : theme.textMuted }}>
                      +{s.creators.listedLast24h.toLocaleString()} in the last 24 hours · +{(s.creators.listedLast7d ?? 0).toLocaleString()} this week
                    </div>
                  )}
                  <div style={{ color: theme.textMuted }}>
                    {s.creators.shownToBrands.toLocaleString()} shown · {s.creators.hiddenFromBrands.toLocaleString()} hidden
                  </div>
                  {s.creators.withoutEmail != null && (
                    <div style={{ color: theme.textMuted }}>
                      {(s.creators.withEmail ?? 0).toLocaleString()} with an email · {s.creators.withoutEmail.toLocaleString()} without (hidden)
                    </div>
                  )}
                  {s.creators.openToPartnerships != null && (
                    <div style={{ color: theme.textMuted }}>{s.creators.openToPartnerships.toLocaleString()} open to partnerships</div>
                  )}
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
                <Label>Profiles read at once</Label>
                <Input
                  type="number"
                  min={1}
                  max={20}
                  value={draft.readConcurrency ?? 8}
                  disabled={!canWrite}
                  onChange={(e) => setDraft({ ...draft, readConcurrency: Math.min(20, Math.max(1, Math.round(Number(e.target.value) || 8))) })}
                />
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
                <ListTextarea
                  key={`excluded-${listsKey}`}
                  rows={3}
                  value={draft.excludedCountries}
                  parse={codesIn}
                  join=", "
                  disabled={!canWrite}
                  onChange={(v) => setDraft({ ...draft, excludedCountries: v })}
                />
              </div>
              <div>
                <Label>Hidden from brands until they claim (regions)</Label>
                <ListTextarea
                  key={`hidden-${listsKey}`}
                  rows={3}
                  value={draft.hiddenRegions}
                  parse={codesIn}
                  join=", "
                  disabled={!canWrite}
                  onChange={(v) => setDraft({ ...draft, hiddenRegions: v })}
                />
              </div>
            </div>
            <div style={{ marginTop: 14 }}>
              <Label>Seed queries (one per line; topics, never people)</Label>
              <ListTextarea
                key={`seeds-${listsKey}`}
                rows={4}
                value={draft.seedQueries}
                parse={linesIn}
                join={'\n'}
                disabled={!canWrite}
                onChange={(v) => setDraft({ ...draft, seedQueries: v })}
              />
            </div>
            <div style={{ marginTop: 14 }}>
              <Label>Search each query in</Label>
              <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap' }}>
                {DISCOVERY_SOURCES.map((src) => {
                  const sources = draft.discoverySources ?? SOURCE_DEFAULTS;
                  return (
                    <label key={src.key} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 14 }}>
                      <input
                        type="checkbox"
                        checked={sources[src.key]}
                        disabled={!canWrite}
                        onChange={(e) => setDraft({ ...draft, discoverySources: { ...sources, [src.key]: e.target.checked } })}
                      />
                      {src.label}
                    </label>
                  );
                })}
              </div>
              <div style={{ fontSize: 12, color: theme.textMuted, marginTop: 6 }}>
                Each query is searched once a month. Discover again goes further on the same topics: each query once more for up to 100 results, then
                related queries written from it (up to 20 per query).
              </div>
              <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 14, marginTop: 10 }}>
                <input
                  type="checkbox"
                  checked={draft.requirePartnershipSignal ?? true}
                  disabled={!canWrite}
                  onChange={(e) => setDraft({ ...draft, requirePartnershipSignal: e.target.checked })}
                />
                Only index creators who already take partnerships (a storefront, a sponsor page, sponsored posts, or a profile that says so)
              </label>
            </div>
            <div style={{ marginTop: 14 }}>
              <Label>When a creator hasn&rsquo;t published an email, look one up</Label>
              <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap' }}>
                {(
                  [
                    { key: 'ownDomain', label: 'Work email at their own website’s domain' },
                    { key: 'creatorData', label: 'Creator contact-data lookup (paid per email found)' },
                  ] as const
                ).map((o) => {
                  const lookups = draft.contactEnrichment ?? { creatorData: true, ownDomain: true };
                  return (
                    <label key={o.key} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 14 }}>
                      <input
                        type="checkbox"
                        checked={lookups[o.key]}
                        disabled={!canWrite}
                        onChange={(e) => setDraft({ ...draft, contactEnrichment: { ...lookups, [o.key]: e.target.checked } })}
                      />
                      {o.label}
                    </label>
                  );
                })}
              </div>
              <div style={{ fontSize: 12, color: theme.textMuted, marginTop: 6 }}>
                Creators without an email are kept but hidden from brands, and looked at again every week.
              </div>
            </div>
            {canWrite && (
              <div style={{ display: 'flex', gap: 8, marginTop: 14, alignItems: 'center', flexWrap: 'wrap' }}>
                <Button onClick={() => save.mutate(draft)} disabled={save.isPending}>{save.isPending ? 'Saving…' : 'Save settings'}</Button>
                <Button variant="secondary" onClick={() => replaceDraft(state.data!.settings)}>Discard changes</Button>
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
            {run.isSuccess && (
              <div style={{ fontSize: 13, color: theme.textMuted, marginTop: 10 }}>
                Started. It runs on the Network in the background; this page updates as creators are read.
              </div>
            )}
            {s?.runs && Object.keys(s.runs).length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 14 }}>
                {(['discover', 'read', 'refresh'] as const).map((job) => (
                  <RunLine key={job} job={job} run={s.runs![job]} />
                ))}
              </div>
            )}
            {invites.data && (
              <pre style={{ marginTop: 12, fontSize: 12, background: theme.surface2, padding: 10, borderRadius: theme.radiusSm, overflowX: 'auto' }}>
                {JSON.stringify(invites.data, null, 2)}
              </pre>
            )}
            {canWrite && (
              <div style={{ marginTop: 16 }}>
                <Label>Queue URLs: profiles (LinkedIn, X, YouTube), sponsorship storefronts or sponsor pages</Label>
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
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
              <div style={{ fontSize: 15, fontWeight: 600 }}>Listed creators</div>
              {creators.data?.total != null && (
                <span style={{ fontSize: 13, color: theme.textMuted }}>
                  {searchFor ? `${creators.data.total.toLocaleString()} match` : `${creators.data.total.toLocaleString()} in all`}
                  {creators.data.total > creators.data.creators.length ? `, newest ${creators.data.creators.length} shown` : ''}
                </span>
              )}
              {!searchFor && (s?.creators.listedLast24h ?? 0) > 0 && (
                <span style={{ fontSize: 13, color: theme.success }}>{s!.creators.listedLast24h!.toLocaleString()} new in the last 24 hours</span>
              )}
            </div>
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
                  {(c.partnershipSignals ?? []).map((sig) => (
                    <div key={sig.kind} style={{ fontSize: 12, color: theme.success }}>
                      {brandSignalLabel(sig)}
                      {sig.evidence && (
                        <>
                          {' · '}
                          <a href={sig.evidence} target="_blank" rel="noreferrer noopener" style={{ color: theme.textMuted }}>
                            {shortUrl(sig.evidence)}
                          </a>
                        </>
                      )}
                    </div>
                  ))}
                </div>,
                <div key="w">
                  <div>{`${c.country ?? '—'}${c.region ? ` (${c.region})` : ''}${c.brandVisible ? '' : ' · hidden'}`}</div>
                  {c.location && (
                    <div style={{ fontSize: 12, color: theme.textMuted }}>
                      {c.location.from ? `${PLATFORM_NAME[c.location.from] ?? c.location.from}: ` : ''}“{c.location.text}”
                    </div>
                  )}
                </div>,
                <div key="r">
                  <div style={{ fontWeight: 500 }}>{c.totalReach.toLocaleString()}</div>
                  {c.platforms
                    .filter((p) => p.followerCount != null)
                    .map((p) => (
                      <div key={p.profileUrl} style={{ fontSize: 12, color: theme.textMuted, whiteSpace: 'nowrap' }}>
                        {PLATFORM_NAME[p.platform] ?? p.platform} {p.followerCount!.toLocaleString()}
                      </div>
                    ))}
                </div>,
                c.contact ? (
                  <div key="a">
                    <div>{`${c.contact.masked}${c.contact.verified ? '' : ' (unverified)'}`}</div>
                    {c.contact.foundOn && (
                      <div style={{ fontSize: 12, color: theme.textMuted }}>{contactFrom(c.contact.foundOn)}</div>
                    )}
                  </div>
                ) : (
                  <span key="a" style={{ color: theme.textMuted }}>none yet · hidden from brands</span>
                ),
                <div key="s">
                  <div>{`${c.status}${c.emailsSent ? ` · ${c.emailsSent} sent` : ''}`}</div>
                  {c.listedAt && (
                    <div style={{ fontSize: 12, color: isNew(c.listedAt) ? theme.success : theme.textMuted, whiteSpace: 'nowrap' }}>
                      {isNew(c.listedAt) ? 'new · ' : ''}listed {formatDate(c.listedAt, { relative: true })}
                    </div>
                  )}
                </div>,
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
