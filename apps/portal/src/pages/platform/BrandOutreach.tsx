/**
 * Brand outreach (openpartner-network docs/brand-outreach.md §6): software
 * companies that launched on Product Hunt recently and have no partner
 * program yet. Everything lives on the Network; this page reads and writes
 * it through the admin key.
 *
 *   - Prospects: to review (held by the classifier's judgement or for want
 *     of an address, to approve or reject), ready (their wait after launch
 *     is over), waiting, queued, emailed, rejected by reason. Each with its
 *     site, launch, the words that place it in the US and its address,
 *     masked.
 *   - Email: the email's next batch previewed as it would go, sent by an
 *     admin, and a sample to seed addresses.
 *   - Runs: spend, counts, each job's latest run, launch pages by hand.
 *   - Settings: on/off, budget, queries, the waits.
 *
 * Support operators can look; changes, runs, approvals, rejections and full
 * addresses need an admin.
 */

import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { theme } from '../../theme.js';
import { Button, Card, ErrorBanner, Input, Label, Page, Select, Table, Textarea, formatDate } from '../../ui.js';
import { friendlyPlatformError, papi, type PlatformOperator } from './lib.js';
import { shortUrl } from '../../lib/partnership-signals.js';
import { useRestOfWindow } from '../../lib/useRestOfWindow.js';

interface BrandSettings {
  enabled: boolean;
  /** Absent from a Network that predates the email, and then not offered. */
  outreachEnabled?: boolean;
  outreachStyle?: 'designed' | 'plain';
  monthlyBudgetUsd: number;
  /** These four are absent from a Network that predates them, and then not
   *  offered (nor sent). */
  sources?: Record<SourceKey, boolean>;
  jobQueries?: string[];
  minCreatorMentions?: number;
  excludedCountries?: string[];
  /** Exa's company data past either is too big. Absent from a Network that
   *  predates the size check. */
  maxEmployees?: number;
  maxFundingUsdMillions?: number;
  queries: string[];
  lookbackDays: number;
  sendAfterDays: number;
  maxLaunchAgeDays: number;
  readConcurrency: number;
}

interface SettingsState {
  settings: BrandSettings;
  defaults: BrandSettings;
  updatedAt: string | null;
  updatedByEmail: string | null;
  configured?: { exa: boolean; treg: boolean; classifier: boolean; classifierModel: string };
  /** Never emailed on top of the list: Japan, South Korea and Israel, and
   *  the Network's sanctioned and policy-blocked countries. */
  blockedCountries?: string[];
}

type Job = 'discover' | 'read' | 'outreach';

interface Run {
  startedAt: string;
  /** Null while it's running. */
  finishedAt: string | null;
  result: Record<string, unknown> | null;
}

interface Stats {
  byStatus: Record<string, number>;
  ready: number;
  waiting: number;
  rejections: Record<string, number>;
  /** Held for review, by why. */
  held?: Record<string, number>;
  siteFoundBy: Record<string, number>;
  /** What Exa's copies of the launch pages held. */
  copyLinks?: Record<string, number>;
  spend: { thisMonthUsd: number; budgetUsd: number };
  enabled: boolean;
  outreachEnabled?: boolean;
  /** The outreach mailbox's day, shared with the creator index's email. */
  outreach?: { dailyLimit: number; sentLastDay: number };
  runs: Partial<Record<Job, Run>>;
  queriesSearchedAt: Record<string, string>;
}

interface Prospect {
  id: string;
  status: string;
  launchUrl: string | null;
  launchedAt: string | null;
  discoveredBy: string;
  name: string | null;
  siteUrl: string | null;
  siteFoundBy: 'copy' | 'search' | null;
  summary: string | null;
  categories: string[];
  country: string | null;
  countryEvidence: string | null;
  pricingUrl: string | null;
  contact: { masked: string; foundOn: string | null } | null;
  /** Why it was rejected, or why it's held for review. */
  rejectReason: string | null;
  /** What the classifier said, for one held for review. */
  reviewNote?: string | null;
  /** product_hunt, job_post or creators. */
  launchSite?: string;
  /** What found it: "Hiring: Head of Partnerships", "Mentioned by 12 creators". */
  sourceNote?: string | null;
  /** Exa's company data in a line: "≈12 employees · Seed · $3.5M raised". */
  companySize?: string | null;
  dueAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ProspectsPage {
  prospects: Prospect[];
  nextCursor: string | null;
}

type View = 'review' | 'ready' | 'waiting' | 'queued' | 'emailed' | 'rejected';
const VIEWS: Array<{ key: View; label: string }> = [
  { key: 'review', label: 'To review' },
  { key: 'ready', label: 'Ready' },
  { key: 'waiting', label: 'Waiting' },
  { key: 'queued', label: 'Queued' },
  { key: 'emailed', label: 'Emailed' },
  { key: 'rejected', label: 'Rejected' },
];

const REASONS: Record<string, string> = {
  no_copy: 'no copy at Exa',
  no_website: 'no website found',
  site_unreadable: 'site unreadable',
  duplicate_domain: 'same company',
  on_openpartner: 'on OpenPartner',
  suppressed: 'blocked',
  has_affiliate_program: 'has a program',
  classifier_declined: 'classifier declined',
  not_software: 'not software',
  no_paid_plans: 'no paid plans',
  country_unknown: 'country unknown',
  not_us: 'not US',
  no_address: 'no address',
  address_refused: 'refuses email',
  read_failed: 'read failed',
  too_old: 'too old',
  excluded_country: 'excluded country',
  large_company: 'large company',
  ops: 'rejected by ops',
};

const reasonLabel = (r: string) => REASONS[r] ?? r.replace(/_/g, ' ');

/** The Network's refusals of an approval, as ops read them. */
const APPROVE_ERRORS: Record<string, string> = {
  country_required: 'Say which country it is in',
  invalid_country: 'Not a country code',
  excluded_country: "That country isn't emailed",
  no_address: 'Add an address first',
  invalid_email: 'Not an email address',
  not_their_address: 'Use an address at their domain or a free-mail one, not support@ or sales@',
  not_their_page: 'The page must be on their own site',
  refuses_unsolicited: 'That page asks not to be emailed',
  suppressed: 'That address or domain is blocked',
  undeliverable: "The verifier says it won't deliver",
  verify_unavailable: "The verifier isn't available; try again later",
  not_found: 'No longer waiting for review',
};
const approveError = (err: unknown) => {
  const code = err instanceof Error ? err.message : String(err);
  return APPROVE_ERRORS[code] ?? friendlyPlatformError(err);
};

type Tab = 'prospects' | 'email' | 'runs' | 'settings';
const TABS: Array<{ key: Tab; label: string }> = [
  { key: 'prospects', label: 'Prospects' },
  { key: 'email', label: 'Email' },
  { key: 'runs', label: 'Runs' },
  { key: 'settings', label: 'Settings' },
];

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

function Tabs({ tab, onTab, notes }: { tab: Tab; onTab: (t: Tab) => void; notes: Partial<Record<Tab, React.ReactNode>> }) {
  return (
    <div role="tablist" aria-label="Brand outreach" style={{ display: 'flex', gap: 4, borderBottom: `1px solid ${theme.border}`, marginBottom: 16 }}>
      {TABS.map((t) => (
        <button
          key={t.key}
          type="button"
          role="tab"
          aria-selected={tab === t.key}
          onClick={() => onTab(t.key)}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 8,
            background: 'none',
            border: 'none',
            borderBottom: `2px solid ${tab === t.key ? theme.accent : 'transparent'}`,
            marginBottom: -1,
            padding: '8px 12px',
            color: tab === t.key ? theme.text : theme.textMuted,
            fontSize: 14,
            fontWeight: 600,
            whiteSpace: 'nowrap',
            cursor: 'pointer',
          }}
        >
          {t.label}
          {notes[t.key] ? ' ' : null}
          {notes[t.key]}
        </button>
      ))}
    </div>
  );
}

const n = (r: Record<string, unknown>, k: string) => (typeof r[k] === 'number' ? (r[k] as number) : 0);
const counts = (v: unknown) =>
  Object.entries((v ?? {}) as Record<string, number>)
    .filter(([, x]) => x > 0)
    .map(([k, x]) => `${reasonLabel(k)} ${x}`)
    .join(' · ');

const sum = (v: unknown) => Object.values((v ?? {}) as Record<string, number>).reduce((a, b) => a + b, 0);

/** What a finished run did, in one line. */
function runSummary(job: Job, r: Record<string, unknown> | null): string {
  if (!r) return '';
  if (typeof r.error === 'string') return `failed: ${r.error}`;
  const stopped = typeof r.stoppedBy === 'string' ? `stopped: ${r.stoppedBy}` : '';
  if (r.ran === false) return [n(r, 'expired') ? `${n(r, 'expired')} expired` : '', stopped || 'off'].filter(Boolean).join(' · ');
  const parts =
    job === 'outreach'
      ? [
          `${n(r, 'sent')} sent`,
          n(r, 'skipped') ? `${n(r, 'skipped')} skipped` : '',
          n(r, 'failed') ? `${n(r, 'failed')} refused, to retry` : '',
          r.dailyLimitReached ? 'stopped at the daily limit' : '',
        ]
      : job === 'discover'
      ? [
          `${n(r, 'searches')} searches`,
          `${n(r, 'queued')} new launches`,
          n(r, 'wholeSite') ? `${n(r, 'wholeSite')} on the whole site` : '',
          n(r, 'failed') ? `${n(r, 'failed')} failed` : '',
        ]
      : [
          `${n(r, 'read')} read`,
          `${n(r, 'qualified')} qualified`,
          sum(r.held) ? `${sum(r.held)} to review` : '',
          counts(r.rejected),
          n(r, 'retried') ? `${n(r, 'retried')} to retry` : '',
          n(r, 'expired') ? `${n(r, 'expired')} expired` : '',
        ];
  return [...parts, stopped].filter(Boolean).join(' · ');
}

/** Phase 1's questions, from the latest read: what Exa's copies held and
 *  where websites came from. */
function readDiagnostics(r: Record<string, unknown> | null): string | null {
  const copies = r?.copies as Record<string, number> | undefined;
  const website = r?.website as Record<string, number> | undefined;
  if (!copies || !website) return null;
  const size = r?.size as { checked?: number; withData?: number; tooBig?: Record<string, number>; placed?: number } | undefined;
  return [
    `Copies: ${copies.websiteLink ?? 0} with a website link · ${copies.onlyRedirectLinks ?? 0} only Product Hunt links · ${copies.noLinks ?? 0} no links.`,
    `Websites: ${website.copy ?? 0} from the copy · ${website.search ?? 0} by search · ${website.none ?? 0} none.`,
    size ? `Size: ${size.withData ?? 0} of ${size.checked ?? 0} with Exa data · ${sum(size.tooBig)} too big · ${size.placed ?? 0} placed by headquarters` : '',
  ]
    .filter(Boolean)
    .join(' ');
}

function RunLine({ job, run }: { job: Job; run: Run | undefined }) {
  if (!run) return null;
  const diag = job === 'read' && run.finishedAt ? readDiagnostics(run.result) : null;
  const found = job === 'discover' && run.finishedAt ? ((run.result?.found ?? {}) as Record<string, { new: number; known: number; unusable: number; wholeSite?: boolean }>) : {};
  const kinds = job === 'discover' && run.finishedAt ? ((run.result?.unusableKinds ?? {}) as Record<string, number>) : {};
  return (
    <div style={{ fontSize: 13, lineHeight: 1.5 }}>
      <strong>{job === 'discover' ? 'Discover' : job === 'read' ? 'Read' : 'Email batch'}</strong>{' '}
      <span style={{ color: theme.textMuted }}>
        {run.finishedAt ? `${formatDate(run.finishedAt, { relative: true })}: ${runSummary(job, run.result)}` : `running since ${formatDate(run.startedAt, { relative: true })}…`}
      </span>
      {diag && <div style={{ color: theme.textMuted, fontSize: 12 }}>{diag}</div>}
      {Object.keys(found).length > 0 && (
        <div style={{ color: theme.textMuted, fontSize: 12 }}>
          {Object.entries(found)
            .map(([q, c]) => `${q}: ${c.new} new, ${c.known} known${c.unusable ? `, ${c.unusable} other pages` : ''}${c.wholeSite ? ' (whole site)' : ''}`)
            .join(' · ')}
        </div>
      )}
      {Object.keys(kinds).length > 0 && (
        <div style={{ color: theme.textMuted, fontSize: 12 }}>
          Other pages:{' '}
          {Object.entries(kinds)
            .sort((a, b) => b[1] - a[1])
            .map(([k, c]) => `/${k} ${c}`)
            .join(' · ')}
        </div>
      )}
    </div>
  );
}

function ContactCell({ p, canWrite }: { p: Prospect; canWrite: boolean }) {
  const show = useMutation({
    mutationFn: () => papi<{ contact: { email: string } }>(`/platform-admin/brand-outreach/prospects/${encodeURIComponent(p.id)}/contact`),
  });
  if (!p.contact) return <span style={{ color: theme.textDim }}>—</span>;
  return (
    <div style={{ fontSize: 13 }}>
      <span style={{ marginRight: 6 }}>{show.data?.contact.email ?? p.contact.masked}</span>
      {canWrite && !show.data && (
        <Button variant="ghost" size="sm" disabled={show.isPending} onClick={() => show.mutate()}>
          Show
        </Button>
      )}
      {p.contact.foundOn && (
        <div>
          <a href={p.contact.foundOn} target="_blank" rel="noreferrer" style={{ color: theme.textMuted, fontSize: 12 }}>
            {shortUrl(p.contact.foundOn)}
          </a>
        </div>
      )}
    </div>
  );
}

function CompanyCell({ p }: { p: Prospect }) {
  return (
    <div style={{ maxWidth: 360 }}>
      {p.siteUrl ? (
        <a href={p.siteUrl} target="_blank" rel="noreferrer" style={{ color: theme.text, fontWeight: 600 }}>
          {p.name ?? shortUrl(p.siteUrl)}
        </a>
      ) : (
        <span style={{ fontWeight: 600 }}>{p.name ?? '—'}</span>
      )}
      {p.summary && <div style={{ color: theme.textMuted, fontSize: 12 }}>{p.summary}</div>}
      {p.companySize && <div style={{ color: theme.textMuted, fontSize: 12 }}>{p.companySize}</div>}
      {p.categories.length > 0 && <div style={{ color: theme.textDim, fontSize: 12 }}>{p.categories.join(', ')}</div>}
    </div>
  );
}

/** Where each source's prospects come from, as ops read it. */
type SourceKey = 'productHunt' | 'jobPosts' | 'creatorMentions';
const SOURCES: Array<{ key: SourceKey; label: string }> = [
  { key: 'productHunt', label: 'Product Hunt launches' },
  { key: 'jobPosts', label: 'Companies hiring for partnerships' },
  { key: 'creatorMentions', label: 'Brands creators mention' },
];
const SITE_LABEL: Record<string, string> = { product_hunt: 'Product Hunt', job_post: 'Job post', creators: 'Creators' };

function LaunchCell({ p }: { p: Prospect }) {
  const site = SITE_LABEL[p.launchSite ?? 'product_hunt'] ?? 'Product Hunt';
  return (
    <div style={{ fontSize: 13, whiteSpace: 'nowrap' }}>
      {p.launchUrl ? (
        <a href={p.launchUrl} target="_blank" rel="noreferrer" style={{ color: theme.text }}>
          {p.launchedAt ? formatDate(p.launchedAt) : site}
        </a>
      ) : (
        <span>{p.launchedAt ? formatDate(p.launchedAt) : site}</span>
      )}
      {p.sourceNote && <div style={{ fontSize: 12, whiteSpace: 'normal', maxWidth: 220 }}>{p.sourceNote}</div>}
      <div style={{ color: theme.textDim, fontSize: 12 }} title={p.discoveredBy}>
        {p.discoveredBy === 'ops' ? 'added by ops' : p.discoveredBy === 'creators' ? 'creator mentions' : p.discoveredBy.replace(/^exa:/, '')}
      </div>
    </div>
  );
}

/** Why a launch is held, and what the classifier said. */
function HeldCell({ p }: { p: Prospect }) {
  return (
    <div style={{ fontSize: 13, maxWidth: 280 }}>
      <div>{reasonLabel(p.rejectReason ?? '')}</div>
      {p.country && p.country !== 'US' && <div style={{ color: theme.textMuted, fontSize: 12 }}>{p.country}</div>}
      {(p.reviewNote ?? p.countryEvidence) && <div style={{ color: theme.textDim, fontSize: 12 }}>“{p.reviewNote ?? p.countryEvidence}”</div>}
    </div>
  );
}

/** Approve a held launch as a US company, or reject it. With no address
 *  found, an admin gives one published on their site, with its page. */
function ReviewActions({ p, onDone }: { p: Prospect; onDone: () => void }) {
  const [adding, setAdding] = useState(false);
  const [email, setEmail] = useState('');
  const [page, setPage] = useState('');
  // Its pages didn't place it: ops say where it is.
  const needsCountry = !p.country;
  const [country, setCountry] = useState('');
  const approve = useMutation({
    mutationFn: () =>
      papi(`/platform-admin/brand-outreach/prospects/${encodeURIComponent(p.id)}/approve`, {
        method: 'POST',
        body: {
          ...(needsCountry ? { country: country.trim().toUpperCase() } : {}),
          ...(p.contact ? {} : { email: email.trim(), sourceUrl: page.trim() }),
        },
      }),
    onSuccess: onDone,
  });
  const reject = useMutation({
    mutationFn: () => papi(`/platform-admin/brand-outreach/prospects/${encodeURIComponent(p.id)}/reject`, { method: 'POST' }),
    onSuccess: onDone,
  });
  const name = p.name ?? 'this launch';
  const busy = approve.isPending || reject.isPending;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 180 }}>
      {needsCountry && (p.contact || adding) && (
        <Input aria-label="Country" placeholder="Country code, e.g. US" maxLength={2} value={country} onChange={(e) => setCountry(e.target.value.toUpperCase())} />
      )}
      {adding && !p.contact && (
        <>
          <Input aria-label="Address" placeholder="founder@their.site" value={email} onChange={(e) => setEmail(e.target.value)} />
          <Input aria-label="Page it's on" placeholder="https://their.site/about" value={page} onChange={(e) => setPage(e.target.value)} />
        </>
      )}
      <div style={{ display: 'flex', gap: 6 }}>
        {p.contact || adding ? (
          <Button
            size="sm"
            disabled={busy || (!p.contact && (!email.trim() || !page.trim())) || (needsCountry && country.trim().length !== 2)}
            onClick={() => {
              const where = needsCountry ? country.trim().toUpperCase() : p.country;
              if (window.confirm(`Approve ${name} as a software company in ${where} with paid plans and no partner program?`)) approve.mutate();
            }}
          >
            Approve
          </Button>
        ) : (
          <Button size="sm" variant="secondary" onClick={() => setAdding(true)}>
            Add address
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => {
            if (window.confirm(`Reject ${name}? It won't be read or emailed again.`)) reject.mutate();
          }}
        >
          Reject
        </Button>
      </div>
      {(approve.error || reject.error) && (
        <div role="alert" style={{ color: theme.danger, fontSize: 12 }}>
          {approve.error ? approveError(approve.error) : friendlyPlatformError(reject.error)}
        </div>
      )}
    </div>
  );
}

const lines = (s: string) => [...new Set(s.split(/\n/).map((l) => l.trim()).filter(Boolean))];

interface OutreachTarget {
  id: string;
  name: string | null;
  siteUrl: string | null;
  sourceNote: string | null;
  country: string | null;
  /** Masked. */
  address: string;
  addressFoundOn: string | null;
  opening: string;
  skip?: string;
}

interface OutreachPreview {
  enabled: boolean;
  style: string;
  mailerConfigured: boolean;
  sender: string | null;
  senderName: string | null;
  due: number;
  waiting: number;
  candidates: number;
  dailyLimit: number;
  sentLastDay: number;
  targets?: OutreachTarget[];
}

const SKIPS: Record<string, string> = {
  suppressed: 'blocked',
  on_openpartner: 'on OpenPartner',
  refuses_unsolicited: 'page refuses email',
  source_unreadable: "source page didn't load",
  excluded_country: 'country never emailed',
};

/** The email's next batch, previewed as it would go, then sent; and a
 *  sample to seed addresses. Sending and samples are an admin's. */
function EmailTab({ canWrite, onSent }: { canWrite: boolean; onSent: () => void }) {
  const [size, setSize] = useState(25);
  const preview = useMutation({
    mutationFn: () => papi<OutreachPreview>('/platform-admin/brand-outreach/outreach/run', { method: 'POST', body: { dryRun: true, limit: size } }),
  });
  const send = useMutation({
    mutationFn: () => papi('/platform-admin/brand-outreach/outreach/run', { method: 'POST', body: { dryRun: false, limit: size } }),
    onSuccess: () => {
      preview.reset();
      onSent();
    },
  });
  const [to, setTo] = useState('');
  const [style, setStyle] = useState<'' | 'plain' | 'designed'>('');
  const sample = useMutation({
    mutationFn: () =>
      papi<{ subject: string; sent: string[]; failed: Array<{ to: string }> }>('/platform-admin/brand-outreach/outreach/sample', {
        method: 'POST',
        body: { to: lines(to), ...(style ? { style } : {}) },
      }),
  });
  const p = preview.data;
  const going = p?.targets?.filter((t) => !t.skip).length ?? 0;
  const error = preview.error ?? send.error ?? sample.error;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <ErrorBanner error={error ? friendlyPlatformError(error) : null} />
      <Card>
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div style={{ width: 120 }}>
            <Label>Batch size</Label>
            <Input type="number" min={1} max={50} aria-label="Batch size" value={size} onChange={(e) => setSize(Math.min(50, Math.max(1, Math.round(Number(e.target.value) || 1))))} />
          </div>
          <Button variant="secondary" disabled={preview.isPending} onClick={() => preview.mutate()}>
            {preview.isPending ? 'Checking…' : 'Preview batch'}
          </Button>
          {canWrite && p && (
            <Button
              disabled={send.isPending || !p.enabled || !p.mailerConfigured || going === 0}
              onClick={() => {
                if (window.confirm(`Send the email to ${going} ${going === 1 ? 'company' : 'companies'} as ${p.senderName ?? p.sender}?`)) send.mutate();
              }}
            >
              Send this batch
            </Button>
          )}
          {send.isSuccess && <span style={{ fontSize: 13, color: theme.success }}>Sending; see Runs.</span>}
        </div>
        {p && (
          <div style={{ marginTop: 12, fontSize: 13, color: theme.textMuted }}>
            {p.due} due · {p.waiting} waiting · sends as {p.senderName ? `${p.senderName} <${p.sender}>` : p.sender ?? 'nobody'} · {p.style} · {p.sentLastDay} of {p.dailyLimit} sent in the last 24 hours
            {!p.enabled && <div style={{ color: theme.danger }}>The email is off in Settings.</div>}
            {!p.mailerConfigured && <div style={{ color: theme.danger }}>No outreach mailbox is set up.</div>}
          </div>
        )}
      </Card>
      {p?.targets && (
        <Table
          dense
          columns={['Company', 'Address', 'Opens with', '']}
          rows={p.targets.map((t) => [
            <div key="c" style={{ maxWidth: 240 }}>
              <div style={{ fontWeight: 600 }}>{t.name ?? '—'}</div>
              {t.sourceNote && <div style={{ fontSize: 12, color: theme.textMuted }}>{t.sourceNote}</div>}
              {t.country && <div style={{ fontSize: 12, color: theme.textDim }}>{t.country}</div>}
            </div>,
            <div key="a" style={{ fontSize: 13 }}>
              {t.address}
              {t.addressFoundOn && <div style={{ fontSize: 12, color: theme.textMuted }}>{shortUrl(t.addressFoundOn)}</div>}
            </div>,
            <div key="o" style={{ fontSize: 13, maxWidth: 420, whiteSpace: 'normal' }}>{t.opening}</div>,
            <span key="s" style={{ fontSize: 12, color: t.skip ? theme.danger : theme.textMuted }}>{t.skip ? `skipped: ${SKIPS[t.skip] ?? t.skip}` : ''}</span>,
          ])}
          empty="Nobody is due."
        />
      )}
      {canWrite && (
        <Card>
          <Label>Send a sample to</Label>
          <Textarea rows={2} aria-label="Sample addresses" placeholder="One address a line" value={to} onChange={(e) => setTo(e.target.value)} />
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8, flexWrap: 'wrap' }}>
            <Select aria-label="Sample style" value={style} onChange={(e) => setStyle(e.target.value as '' | 'plain' | 'designed')}>
              <option value="">The batches' style</option>
              <option value="plain">Plain</option>
              <option value="designed">Designed</option>
            </Select>
            <Button size="sm" variant="secondary" disabled={sample.isPending || lines(to).length === 0} onClick={() => sample.mutate()}>
              {sample.isPending ? 'Sending…' : 'Send sample'}
            </Button>
            {sample.data && (
              <span style={{ fontSize: 12, color: theme.textMuted }}>
                Sent to {sample.data.sent.length}
                {sample.data.failed.length ? `, ${sample.data.failed.length} failed` : ''}
              </span>
            )}
          </div>
        </Card>
      )}
    </div>
  );
}

export function BrandOutreachPage({ operator }: { operator: PlatformOperator }) {
  const canWrite = operator.role === 'admin';
  const qc = useQueryClient();
  const state = useQuery({ queryKey: ['platform-brand-outreach'], queryFn: () => papi<SettingsState>('/platform-admin/brand-outreach/settings') });
  // While a run is going, and for a little while after one is started, the
  // counts and the list refresh themselves.
  const [watchUntil, setWatchUntil] = useState(0);
  const poll = (data: Stats | undefined) => (Object.values(data?.runs ?? {}).some((r) => r && !r.finishedAt) || Date.now() < watchUntil ? 4_000 : false);
  const stats = useQuery({
    queryKey: ['platform-brand-outreach-stats'],
    queryFn: () => papi<Stats>('/platform-admin/brand-outreach/stats'),
    refetchInterval: (query) => poll(query.state.data),
  });
  const watching = poll(stats.data) !== false;
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['platform-brand-outreach'] });
    qc.invalidateQueries({ queryKey: ['platform-brand-outreach-stats'] });
    qc.invalidateQueries({ queryKey: ['platform-brand-outreach-prospects'] });
  };

  const [draft, setDraft] = useState<BrandSettings | null>(null);
  // The list scrolls within the window, like the creator index's.
  const [listRef, listHeight] = useRestOfWindow(34);
  const [queriesText, setQueriesText] = useState('');
  const [jobsText, setJobsText] = useState('');
  const [countriesText, setCountriesText] = useState('');
  const showLists = (s: BrandSettings) => {
    setQueriesText(s.queries.join('\n'));
    setJobsText((s.jobQueries ?? []).join('\n'));
    setCountriesText((s.excludedCountries ?? []).join(' '));
  };
  useEffect(() => {
    if (state.data && !draft) {
      setDraft(state.data.settings);
      showLists(state.data.settings);
    }
  }, [state.data, draft]);
  const save = useMutation({
    mutationFn: (s: BrandSettings) => papi<{ settings: BrandSettings }>('/platform-admin/brand-outreach/settings', { method: 'PUT', body: s }),
    onSuccess: (r) => {
      setDraft(r.settings);
      showLists(r.settings);
      refresh();
    },
  });

  const [seedText, setSeedText] = useState('');
  const seeds = useMutation({
    mutationFn: () => papi<Record<string, number>>('/platform-admin/brand-outreach/seeds', { method: 'POST', body: { urls: lines(seedText) } }),
    onSuccess: () => {
      setSeedText('');
      refresh();
    },
  });
  const run = useMutation({
    mutationFn: (job: Job) => papi<Record<string, unknown>>(`/platform-admin/brand-outreach/run/${job}`, { method: 'POST' }),
    onSuccess: () => {
      setWatchUntil(Date.now() + 20_000);
      refresh();
    },
  });

  const [view, setView] = useState<View>('review');
  const [reason, setReason] = useState('');
  const [q, setQ] = useState('');
  const [searchFor, setSearchFor] = useState('');
  const listQuery = new URLSearchParams({ view });
  if ((view === 'rejected' || view === 'review') && reason) listQuery.set('reason', reason);
  if (searchFor) listQuery.set('q', searchFor);
  const prospects = useInfiniteQuery({
    queryKey: ['platform-brand-outreach-prospects', listQuery.toString()],
    queryFn: ({ pageParam }) => {
      const p = new URLSearchParams(listQuery);
      if (pageParam) p.set('after', pageParam);
      return papi<ProspectsPage>(`/platform-admin/brand-outreach/prospects?${p.toString()}`);
    },
    initialPageParam: '',
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: (query) => (watching && (query.state.data?.pages.length ?? 1) <= 1 ? 4_000 : false),
  });
  const listed = prospects.data?.pages.flatMap((p) => p.prospects) ?? [];
  const reject = useMutation({
    mutationFn: (id: string) => papi(`/platform-admin/brand-outreach/prospects/${encodeURIComponent(id)}/reject`, { method: 'POST' }),
    onSuccess: refresh,
  });

  const [params, setParams] = useSearchParams();
  const tab: Tab = TABS.find((t) => t.key === params.get('tab'))?.key ?? 'prospects';
  const s = stats.data;
  const configured = state.data?.configured;
  const running = Object.values(s?.runs ?? {}).some((r) => r && !r.finishedAt);
  const unsaved = !!draft && !!state.data && JSON.stringify(draft) !== JSON.stringify(state.data.settings);
  const waitTooLong = !!draft && draft.maxLaunchAgeDays <= draft.sendAfterDays;
  const error = save.error ?? seeds.error ?? run.error ?? reject.error;
  const viewCount = (v: View): number | null => {
    if (!s) return null;
    if (v === 'ready') return s.ready;
    if (v === 'waiting') return s.waiting;
    return s.byStatus[v] ?? 0;
  };

  const rows =
    view === 'review'
      ? listed.map((p) => [
          <CompanyCell key="c" p={p} />,
          <LaunchCell key="l" p={p} />,
          <HeldCell key="h" p={p} />,
          <ContactCell key="a" p={p} canWrite={canWrite} />,
          canWrite ? <ReviewActions key="x" p={p} onDone={refresh} /> : <span key="x" />,
        ])
      : view === 'rejected'
      ? listed.map((p) => [
          <span key="r">{reasonLabel(p.rejectReason ?? '')}</span>,
          <LaunchCell key="l" p={p} />,
          <span key="f" style={{ color: theme.textMuted, fontSize: 13 }}>
            {p.siteFoundBy === 'search' ? 'site by search' : p.siteFoundBy === 'copy' ? 'site from copy' : '—'}
          </span>,
          <span key="u" style={{ color: theme.textMuted, fontSize: 13 }}>
            {formatDate(p.updatedAt, { relative: true })}
          </span>,
        ])
      : listed.map((p) => [
          <CompanyCell key="c" p={p} />,
          <LaunchCell key="l" p={p} />,
          <span key="k" title={p.countryEvidence ?? undefined} style={{ fontSize: 13 }}>
            {p.country ?? '—'}
            {p.countryEvidence && <div style={{ color: theme.textDim, fontSize: 12, maxWidth: 220 }}>“{p.countryEvidence}”</div>}
          </span>,
          <ContactCell key="a" p={p} canWrite={canWrite} />,
          <span key="d" style={{ fontSize: 13, whiteSpace: 'nowrap' }}>
            {p.dueAt ? formatDate(p.dueAt) : formatDate(p.updatedAt, { relative: true })}
          </span>,
          canWrite && (p.status === 'qualified' || p.status === 'queued') ? (
            <Button
              key="x"
              variant="ghost"
              size="sm"
              disabled={reject.isPending}
              onClick={() => {
                if (window.confirm(`Reject ${p.name ?? 'this launch'}? It won't be read or emailed again.`)) reject.mutate(p.id);
              }}
            >
              Reject
            </Button>
          ) : (
            <span key="x" />
          ),
        ]);

  return (
    <Page title="Brand outreach" subtitle="New Product Hunt launches with no partner program, found and checked before anyone is emailed.">
      <ErrorBanner error={error ? friendlyPlatformError(error) : state.error ?? stats.error ?? prospects.error} />
      {!state.data || !draft ? (
        <Card>Loading…</Card>
      ) : (
        <>
          <Tabs
            tab={tab}
            onTab={(t) => setParams(t === 'prospects' ? {} : { tab: t }, { replace: true })}
            notes={{ runs: running && <Pill on>running</Pill>, settings: unsaved && <Pill on={false}>unsaved</Pill> }}
          />

          {tab === 'email' && <EmailTab canWrite={canWrite} onSent={() => {
            setWatchUntil(Date.now() + 20_000);
            refresh();
          }} />}

          {tab === 'prospects' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                {VIEWS.map((v) => (
                  <Button
                    key={v.key}
                    variant={view === v.key ? 'primary' : 'secondary'}
                    size="sm"
                    onClick={() => {
                      setView(v.key);
                      setReason('');
                    }}
                  >
                    {v.label}
                    {viewCount(v.key) != null ? ` ${viewCount(v.key)}` : ''}
                  </Button>
                ))}
                {(view === 'rejected' || view === 'review') && s && (
                  <Select aria-label="Reason" value={reason} style={{ width: 'auto', minWidth: 200 }} onChange={(e) => setReason(e.target.value)}>
                    <option value="">Every reason</option>
                    {Object.entries((view === 'review' ? s.held : s.rejections) ?? {}).map(([k, c]) => (
                      <option key={k} value={k}>
                        {reasonLabel(k)} ({c})
                      </option>
                    ))}
                  </Select>
                )}
                <form
                  style={{ display: 'flex', gap: 8, marginLeft: 'auto' }}
                  onSubmit={(e) => {
                    e.preventDefault();
                    setSearchFor(q.trim());
                  }}
                >
                  <Input aria-label="Search prospects" placeholder="Company or domain" value={q} onChange={(e) => setQ(e.target.value)} />
                  <Button type="submit" variant="secondary" size="sm">
                    Search
                  </Button>
                </form>
              </div>
              <div ref={listRef}>
              <Table
                dense
                maxHeight={listHeight}
                columns={
                  view === 'review'
                    ? ['Company', 'Launch', 'Held for', 'Address', '']
                    : view === 'rejected'
                      ? ['Reason', 'Launch', 'Found', 'When']
                      : ['Company', 'Launch', 'Country', 'Address', view === 'ready' || view === 'waiting' ? 'Due' : 'Updated', '']
                }
                rows={rows}
                empty={prospects.isLoading ? 'Loading…' : 'None.'}
                footer={
                  prospects.hasNextPage ? (
                    <div style={{ padding: 12, textAlign: 'center' }}>
                      <Button variant="ghost" size="sm" disabled={prospects.isFetchingNextPage} onClick={() => prospects.fetchNextPage()}>
                        {prospects.isFetchingNextPage ? 'Loading…' : 'Load more'}
                      </Button>
                    </div>
                  ) : undefined
                }
              />
              </div>
            </div>
          )}

          {tab === 'runs' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <Card>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
                  <Pill on={state.data.settings.enabled}>{state.data.settings.enabled ? 'on' : 'off'}</Pill>
                  {configured && (
                    <span style={{ fontSize: 12, color: theme.textMuted }}>
                      Exa {configured.exa ? '✓' : '✗'} · verifier {configured.treg ? '✓' : '✗'} · {configured.classifierModel} {configured.classifier ? '✓' : '✗'}
                    </span>
                  )}
                </div>
                {s && (
                  <div className="op-grid-collapse" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, fontSize: 13 }}>
                    <div>
                      <Label>Spend this month</Label>
                      <div style={{ fontSize: 20, fontWeight: 600 }}>${s.spend.thisMonthUsd.toFixed(2)}</div>
                      <div style={{ color: theme.textMuted }}>of ${s.spend.budgetUsd}</div>
                    </div>
                    <div>
                      <Label>Qualified</Label>
                      <div style={{ fontSize: 20, fontWeight: 600 }}>{(s.byStatus.qualified ?? 0).toLocaleString()}</div>
                      <div style={{ color: theme.textMuted }}>
                        {s.ready} ready · {s.waiting} waiting · {(s.byStatus.review ?? 0).toLocaleString()} to review · {(s.byStatus.queued ?? 0).toLocaleString()} queued
                      </div>
                    </div>
                    <div>
                      <Label>Rejected</Label>
                      <div style={{ fontSize: 20, fontWeight: 600 }}>{(s.byStatus.rejected ?? 0).toLocaleString()}</div>
                      <div style={{ color: theme.textMuted }}>{counts(s.rejections) || '—'}</div>
                    </div>
                  </div>
                )}
              </Card>
              <Card>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <RunLine job="discover" run={s?.runs.discover} />
                  <RunLine job="read" run={s?.runs.read} />
                  <RunLine job="outreach" run={s?.runs.outreach} />
                  {s?.copyLinks && Object.keys(s.copyLinks).length > 0 && (
                    <div style={{ color: theme.textMuted, fontSize: 12 }}>
                      Every launch page read so far: {s.copyLinks.website ?? 0} with a website link · {s.copyLinks.redirect_only ?? 0} only Product Hunt links ·{' '}
                      {s.copyLinks.none ?? 0} no links
                    </div>
                  )}
                  {!s?.runs.discover && !s?.runs.read && <div style={{ color: theme.textMuted, fontSize: 13 }}>No runs yet.</div>}
                </div>
                {canWrite && (
                  <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                    <Button size="sm" disabled={run.isPending || running || !state.data.settings.enabled} onClick={() => run.mutate('discover')}>
                      Discover now
                    </Button>
                    <Button size="sm" variant="secondary" disabled={run.isPending || running || !state.data.settings.enabled} onClick={() => run.mutate('read')}>
                      Read now
                    </Button>
                  </div>
                )}
              </Card>
              {canWrite && (
                <Card>
                  <Label>Launch pages</Label>
                  <Textarea rows={3} aria-label="Launch pages" placeholder="https://www.producthunt.com/products/…" value={seedText} onChange={(e) => setSeedText(e.target.value)} />
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
                    <Button size="sm" variant="secondary" disabled={seeds.isPending || lines(seedText).length === 0} onClick={() => seeds.mutate()}>
                      Queue
                    </Button>
                    {seeds.data && (
                      <span style={{ fontSize: 12, color: theme.textMuted }}>
                        {seeds.data.queued ?? 0} queued · {seeds.data.duplicate ?? 0} known · {seeds.data.invalid ?? 0} not launch pages
                      </span>
                    )}
                  </div>
                </Card>
              )}
            </div>
          )}

          {tab === 'settings' && (
            <Card>
              <div className="op-grid-collapse" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 14 }}>
                <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 14 }}>
                  <input type="checkbox" checked={draft.enabled} disabled={!canWrite} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} />
                  Discovery and reads on
                </label>
                {draft.outreachEnabled !== undefined && (
                  <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 14 }}>
                    <input type="checkbox" checked={draft.outreachEnabled} disabled={!canWrite} onChange={(e) => setDraft({ ...draft, outreachEnabled: e.target.checked })} />
                    Email on
                  </label>
                )}
                {draft.outreachStyle !== undefined && (
                  <div>
                    <Label>Email style</Label>
                    <Select aria-label="Email style" value={draft.outreachStyle} disabled={!canWrite} onChange={(e) => setDraft({ ...draft, outreachStyle: e.target.value as 'plain' | 'designed' })}>
                      <option value="plain">Plain</option>
                      <option value="designed">Designed</option>
                    </Select>
                  </div>
                )}
                <div>
                  <Label>Monthly budget (USD)</Label>
                  <Input type="number" min={0} aria-label="Monthly budget (USD)" value={draft.monthlyBudgetUsd} disabled={!canWrite} onChange={(e) => setDraft({ ...draft, monthlyBudgetUsd: Math.max(0, Math.round(Number(e.target.value) || 0)) })} />
                </div>
                <div>
                  <Label>Read at once</Label>
                  <Input type="number" min={1} max={10} aria-label="Read at once" value={draft.readConcurrency} disabled={!canWrite} onChange={(e) => setDraft({ ...draft, readConcurrency: Math.min(10, Math.max(1, Math.round(Number(e.target.value) || 1))) })} />
                </div>
                <div>
                  <Label>Searches look back (days)</Label>
                  <Input type="number" min={1} max={30} aria-label="Searches look back (days)" value={draft.lookbackDays} disabled={!canWrite} onChange={(e) => setDraft({ ...draft, lookbackDays: Math.min(30, Math.max(1, Math.round(Number(e.target.value) || 1))) })} />
                </div>
                <div>
                  <Label>Email after launch (days)</Label>
                  <Input type="number" min={0} max={60} aria-label="Email after launch (days)" value={draft.sendAfterDays} disabled={!canWrite} onChange={(e) => setDraft({ ...draft, sendAfterDays: Math.min(60, Math.max(0, Math.round(Number(e.target.value) || 0))) })} />
                </div>
                <div>
                  <Label>Too old after (days)</Label>
                  <Input type="number" min={7} max={180} aria-label="Too old after (days)" value={draft.maxLaunchAgeDays} disabled={!canWrite} onChange={(e) => setDraft({ ...draft, maxLaunchAgeDays: Math.min(180, Math.max(7, Math.round(Number(e.target.value) || 7))) })} />
                  {waitTooLong && <div style={{ color: theme.danger, fontSize: 12 }}>Must be over the email wait</div>}
                </div>
                {draft.maxEmployees !== undefined && (
                  <div>
                    <Label>Max employees</Label>
                    <Input type="number" min={5} max={10000} aria-label="Max employees" value={draft.maxEmployees} disabled={!canWrite} onChange={(e) => setDraft({ ...draft, maxEmployees: Math.min(10_000, Math.max(5, Math.round(Number(e.target.value) || 5))) })} />
                  </div>
                )}
                {draft.maxFundingUsdMillions !== undefined && (
                  <div>
                    <Label>Max funding ($M)</Label>
                    <Input type="number" min={1} max={10000} aria-label="Max funding ($M)" value={draft.maxFundingUsdMillions} disabled={!canWrite} onChange={(e) => setDraft({ ...draft, maxFundingUsdMillions: Math.min(10_000, Math.max(1, Math.round(Number(e.target.value) || 1))) })} />
                  </div>
                )}
              </div>
              {draft.sources && (
                <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginTop: 14 }}>
                  {SOURCES.map((src) => (
                    <label key={src.key} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 14 }}>
                      <input
                        type="checkbox"
                        checked={draft.sources![src.key]}
                        disabled={!canWrite}
                        onChange={(e) => setDraft({ ...draft, sources: { ...draft.sources!, [src.key]: e.target.checked } })}
                      />
                      {src.label}
                    </label>
                  ))}
                </div>
              )}
              {draft.excludedCountries && (
                <div style={{ marginTop: 14 }}>
                  <Label>Countries never emailed</Label>
                  <Textarea
                    rows={2}
                    aria-label="Countries never emailed"
                    value={countriesText}
                    disabled={!canWrite}
                    onChange={(e) => {
                      setCountriesText(e.target.value);
                      setDraft({ ...draft, excludedCountries: [...new Set(e.target.value.toUpperCase().split(/[^A-Z]+/).filter((c) => c.length === 2))] });
                    }}
                  />
                  {state.data.blockedCountries && state.data.blockedCountries.length > 0 && (
                    <div style={{ color: theme.textMuted, fontSize: 12 }}>Also never emailed: {state.data.blockedCountries.join(' ')}</div>
                  )}
                </div>
              )}
              {draft.jobQueries && (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 160px', gap: 14, marginTop: 14 }} className="op-grid-collapse">
                  <div>
                    <Label>Roles searched on job boards (one a line)</Label>
                    <Textarea
                      rows={4}
                      aria-label="Roles searched on job boards"
                      value={jobsText}
                      disabled={!canWrite}
                      onChange={(e) => {
                        setJobsText(e.target.value);
                        setDraft({ ...draft, jobQueries: lines(e.target.value).filter((l) => l.length >= 3).slice(0, 30) });
                      }}
                    />
                  </div>
                  {draft.minCreatorMentions != null && (
                    <div>
                      <Label>Creators mentioning a brand</Label>
                      <Input
                        type="number"
                        min={1}
                        max={100}
                        aria-label="Creators mentioning a brand"
                        value={draft.minCreatorMentions}
                        disabled={!canWrite}
                        onChange={(e) => setDraft({ ...draft, minCreatorMentions: Math.min(100, Math.max(1, Math.round(Number(e.target.value) || 1))) })}
                      />
                    </div>
                  )}
                </div>
              )}
              <div style={{ marginTop: 14 }}>
                <Label>Queries (kinds of software, one a line)</Label>
                <Textarea
                  rows={8}
                  aria-label="Queries"
                  value={queriesText}
                  disabled={!canWrite}
                  onChange={(e) => {
                    setQueriesText(e.target.value);
                    setDraft({ ...draft, queries: lines(e.target.value).filter((l) => l.length >= 3).slice(0, 30) });
                  }}
                />
              </div>
              {canWrite && (
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 14 }}>
                  <Button disabled={!unsaved || waitTooLong || save.isPending} onClick={() => save.mutate(draft)}>
                    {save.isPending ? 'Saving…' : 'Save'}
                  </Button>
                  {state.data.updatedAt && (
                    <span style={{ fontSize: 12, color: theme.textMuted }}>
                      Saved {formatDate(state.data.updatedAt, { relative: true })}
                      {state.data.updatedByEmail ? ` by ${state.data.updatedByEmail}` : ''}
                    </span>
                  )}
                </div>
              )}
            </Card>
          )}
        </>
      )}
    </Page>
  );
}
