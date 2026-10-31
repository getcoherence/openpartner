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
 *   - The outreach email: "claim your profile", once, to creators no brand
 *     has written to, previewed and sent in small batches.
 *
 * Support operators can look and dry-run the invite and outreach emails;
 * changes, runs and sends need an admin.
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
  /** Absent from a Network that predates the outreach email. */
  outreachEnabled?: boolean;
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
/** What the runs record holds: the jobs, and outreach batches. */
type RunKind = IndexJob | 'outreach';

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
  /** The mailbox the index's emails go from. */
  outreachMailer?: { configured: boolean; from: string | null };
}

interface Stats {
  creators: {
    byStatus: Record<string, number>;
    listed: number;
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
  /** Outreach emails ever sent (one per creator). */
  outreachSent?: number;
  suppressions: Record<string, number>;
  spend: { thisMonthUsd: number; budgetUsd: number };
  /** Each job's latest run. */
  runs?: Partial<Record<RunKind, IndexRun>>;
}

interface OutreachTarget {
  id: string;
  name: string | null;
  country: string | null;
  region: string | null;
  shownToBrands: boolean;
  totalReach: number;
  address: string;
  addressFoundOn: string | null;
  opening: string;
  skip?: string;
}

interface OutreachPreview {
  enabled: boolean;
  mailerConfigured: boolean;
  sender: string | null;
  due: number;
  candidates: number;
  excluded: Record<string, number>;
  countriesNotCleared: Record<string, number>;
  targets: OutreachTarget[];
}

/** Why a listed creator isn't in the outreach batch, in ops' words. */
const OUTREACH_EXCLUDED: Record<string, string> = {
  already_sent: 'already sent it',
  invite_waiting: 'a brand is waiting (they get the brands’ email)',
  emailed_recently: 'emailed in the last 7 days',
  email_cap: 'had all three emails',
  muted: 'stopped emails',
  no_verified_address: 'no verified email',
  country_not_cleared: 'country not cleared for it',
  published_address_only: 'Canada, Australia or New Zealand, with an email we looked up rather than one they published',
};

/** Why a creator in the batch would be skipped when it's sent. */
const OUTREACH_SKIP: Record<string, string> = {
  suppressed: 'asked to be removed: skipped',
  member: 'already on OpenPartner: skipped',
  nothing_to_name: 'no page to open with: skipped',
  refuses_unsolicited: 'the page with their email refuses unsolicited email: skipped',
  source_unreadable: 'the page with their email can’t be read, and their country needs it: skipped',
};

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

const JOB_LABEL: Record<RunKind, string> = { discover: 'Discover', read: 'Read', refresh: 'Refresh', outreach: 'Outreach email' };

const PLATFORM_NAME: Record<string, string> = { linkedin: 'LinkedIn', twitter: 'X', youtube: 'YouTube', substack: 'Substack', newsletter: 'Newsletter' };

/** Where an address came from, for ops: a page, or one of the lookups. */
function contactFrom(source: string): string {
  if (source === 'via:creator-data') return 'via creator-data lookup';
  if (source.startsWith('via:own-domain:')) return `via work-email lookup (${source.slice('via:own-domain:'.length)})`;
  return shortUrl(source);
}

/** What a finished run did, in one line. */
function runSummary(job: RunKind, r: Record<string, unknown> | null): string {
  if (!r) return '';
  if (typeof r.error === 'string') return `failed: ${r.error}`;
  if (r.ran === false) return 'didn’t run (indexing is off, or there’s nothing to search)';
  const n = (k: string) => (typeof r[k] === 'number' ? (r[k] as number) : 0);
  const parts =
    job === 'outreach'
      ? [`${n('sent')} sent`, n('skipped') ? `${n('skipped')} skipped` : '', n('failed') ? `${n('failed')} refused, to retry` : '']
      : job === 'discover'
      ? [`${n('searches')} searches`, `${n('found')} found`, `${n('queued')} queued`, n('recent') ? `${n('recent')} searched recently, skipped` : '']
      : job === 'read'
        ? [`${n('indexed')} listed`, `${n('rejected')} turned down`, `${n('expanded')} storefronts and pages opened`, n('retried') ? `${n('retried')} to retry` : '', n('deferred') ? `${n('deferred')} waiting` : '', n('failed') ? `${n('failed')} failed` : '']
        : [`${n('refreshed')} refreshed`, `${n('deleted')} removed`, n('deferred') ? `${n('deferred')} waiting` : '', n('errors') ? `${n('errors')} errors` : ''];
  return parts.filter(Boolean).join(' · ');
}

function RunLine({ job, run }: { job: RunKind; run: IndexRun | undefined }) {
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
  brandVisible: boolean;
  totalReach: number;
  contact: { masked: string; foundOn: string | null; verified: boolean } | null;
  emailsSent: number;
  platforms: Array<{ platform: string; handle: string | null; profileUrl: string; followerCount: number | null }>;
  /** With the page each was read from. */
  partnershipSignals?: PartnershipSignal[];
}

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
  const [batchSize, setBatchSize] = useState(50);
  const outreachPreview = useMutation({
    mutationFn: () => papi<OutreachPreview>('/platform-admin/creator-index/outreach/run', { method: 'POST', body: { dryRun: true, limit: batchSize } }),
  });
  // Starts the batch on the Network, which sends it a few seconds apart.
  const outreachSend = useMutation({
    mutationFn: () => papi<{ started: boolean }>('/platform-admin/creator-index/outreach/run', { method: 'POST', body: { dryRun: false, limit: batchSize } }),
    onSuccess: () => {
      outreachPreview.reset();
      setWatchUntil(Date.now() + 20_000);
      refresh();
    },
  });

  const [q, setQ] = useState('');
  const [searchFor, setSearchFor] = useState('');
  const creators = useQuery({
    queryKey: ['platform-creator-index-creators', searchFor],
    queryFn: () => papi<{ creators: OpsCreator[] }>(`/platform-admin/creator-index/creators${searchFor ? `?q=${encodeURIComponent(searchFor)}` : ''}`),
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
  const error = save.error ?? seeds.error ?? run.error ?? invites.error ?? outreachPreview.error ?? outreachSend.error ?? remove.error;
  const mailbox = state.data?.outreachMailer;
  const outreachOn = state.data?.settings.outreachEnabled ?? false;
  const preview = outreachPreview.data;

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
              <Pill on={outreachOn}>{outreachOn ? 'outreach email on' : 'outreach email off'}</Pill>
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
                  {s.outreachSent != null && <div style={{ color: theme.textMuted }}>{s.outreachSent} outreach emails sent</div>}
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
              <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 14 }}>
                <input type="checkbox" checked={draft.outreachEnabled ?? false} disabled={!canWrite} onChange={(e) => setDraft({ ...draft, outreachEnabled: e.target.checked })} />
                Outreach email on
              </label>
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
                A query is searched again in each place after 30 days, so new queries are what find new creators.
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
                {(['discover', 'read', 'refresh', 'outreach'] as const).map((job) => (
                  <RunLine key={job} job={job} run={s.runs![job]} />
                ))}
              </div>
            )}
            {invites.data && (
              <pre style={{ marginTop: 12, fontSize: 12, background: theme.surface2, padding: 10, borderRadius: theme.radiusSm, overflowX: 'auto' }}>
                {JSON.stringify(invites.data, null, 2)}
              </pre>
            )}
            <div style={{ marginTop: 18, paddingTop: 14, borderTop: `1px solid ${theme.borderSubtle}` }}>
              <div style={{ fontSize: 14, fontWeight: 600 }}>Outreach email</div>
              <div style={{ fontSize: 13, color: theme.textMuted, marginTop: 4, lineHeight: 1.5 }}>
                &ldquo;Claim your profile&rdquo;, once ever, to listed creators no brand has written to: the only way in for creators hidden from brands.
                Biggest reach first. It opens with their own storefront or sponsor page, and counts as one of their three emails.{' '}
                {mailbox?.configured ? (
                  <>Sends from {mailbox.from ?? 'the Network’s outreach mailbox'}, a few seconds apart.</>
                ) : (
                  <span style={{ color: theme.danger }}>The Network has no outreach mailbox set up, so nothing can be sent.</span>
                )}
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                <div style={{ width: 120 }}>
                  <Label>Batch size</Label>
                  <Input
                    type="number"
                    min={1}
                    max={100}
                    value={batchSize}
                    onChange={(e) => {
                      setBatchSize(Math.min(100, Math.max(1, Math.round(Number(e.target.value) || 50))));
                      outreachPreview.reset();
                    }}
                  />
                </div>
                <Button variant="secondary" onClick={() => outreachPreview.mutate()} disabled={outreachPreview.isPending}>
                  {outreachPreview.isPending ? 'Previewing…' : 'Preview batch'}
                </Button>
                {canWrite && (
                  <Button
                    onClick={() => {
                      if (window.confirm(`Send the outreach email to ${preview?.candidates ?? batchSize} creators? Each gets it only once.`)) outreachSend.mutate();
                    }}
                    disabled={!preview || preview.candidates === 0 || !outreachOn || !mailbox?.configured || outreachSend.isPending}
                  >
                    Send this batch
                  </Button>
                )}
              </div>
              {canWrite && !outreachOn && <div style={{ fontSize: 12, color: theme.textMuted, marginTop: 6 }}>Switch &ldquo;Outreach email on&rdquo; in Settings to send.</div>}
              {outreachSend.isSuccess && (
                <div style={{ fontSize: 13, color: theme.textMuted, marginTop: 10 }}>
                  Started. The Network sends it a few seconds apart; the run shows above when it&rsquo;s done.
                </div>
              )}
              {preview && (
                <div style={{ marginTop: 12 }}>
                  <div style={{ fontSize: 13 }}>
                    <strong>{preview.due.toLocaleString()}</strong> due now; this batch takes {preview.candidates.toLocaleString()}.
                  </div>
                  {Object.keys(preview.excluded).length > 0 && (
                    <div style={{ fontSize: 12, color: theme.textMuted, marginTop: 4, lineHeight: 1.5 }}>
                      Left out:{' '}
                      {Object.entries(preview.excluded)
                        .map(([k, v]) => `${OUTREACH_EXCLUDED[k] ?? k.replace(/_/g, ' ')} ${v}`)
                        .join(' · ')}
                      {Object.keys(preview.countriesNotCleared).length > 0 &&
                        ` (not cleared: ${Object.entries(preview.countriesNotCleared)
                          .map(([k, v]) => `${k} ${v}`)
                          .join(', ')})`}
                    </div>
                  )}
                  {preview.targets.length > 0 && (
                    <div style={{ marginTop: 10 }}>
                      <Table
                        columns={['Creator', 'Where', 'Reach', 'Email', 'Opens with']}
                        rows={preview.targets.map((t) => [
                          <div key="n">
                            <div style={{ fontWeight: 500 }}>{t.name ?? '—'}</div>
                            {t.skip && <div style={{ fontSize: 12, color: theme.danger }}>{OUTREACH_SKIP[t.skip] ?? t.skip}</div>}
                          </div>,
                          `${t.country ?? '—'}${t.region ? ` (${t.region})` : ''}${t.shownToBrands ? '' : ' · hidden'}`,
                          t.totalReach.toLocaleString(),
                          <div key="a">
                            <div>{t.address}</div>
                            {t.addressFoundOn && <div style={{ fontSize: 12, color: theme.textMuted }}>{contactFrom(t.addressFoundOn)}</div>}
                          </div>,
                          <span key="o" style={{ fontSize: 12 }}>{t.opening}</span>,
                        ])}
                      />
                    </div>
                  )}
                </div>
              )}
            </div>
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
                `${c.country ?? '—'}${c.region ? ` (${c.region})` : ''}${c.brandVisible ? '' : ' · hidden'}`,
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
