import { useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { theme } from '../../theme.js';
import { Button, Card, ErrorBanner, Page, Table } from '../../ui.js';
import { PLATFORM_LABELS } from '../creator/storefront-shared.js';
import {
  papi,
  friendlyPlatformError,
  type NotificationSettings,
  type NotificationsState,
  type PlatformOperator,
  type ReminderRunResult,
  type StorefrontNudgeRunResult,
} from './lib.js';

type Sweep = 'brand-setup' | 'creator-profile' | 'creator-storefront';
type RunResult = ReminderRunResult | StorefrontNudgeRunResult;

/** The preview table for the two step-by-step reminder sweeps. */
function reminderRows(result: RunResult): ReactNode[][] {
  return (result as ReminderRunResult).eligible.map((e) => [
    <div key="r" style={{ minWidth: 0 }}>
      <div style={{ fontSize: 13 }}>{e.slug ? `/t/${e.slug}/` : e.name}</div>
      <div style={{ fontSize: 12, color: theme.textDim }}>{e.email}</div>
    </div>,
    `${e.step} of 3`,
    <span key="m" style={{ fontSize: 12.5, color: theme.textMuted }}>
      {e.missing.join(' · ')}
    </span>,
  ]);
}

/** Where a creator's storefront stands, for the nudge's preview. */
function storefrontState(e: StorefrontNudgeRunResult['eligible'][number]): string {
  if (e.packages === 0 && !e.bookingsOpen) return 'Not started';
  const parts = [`${e.packages} ${e.packages > 0 && e.publishedPackages === 0 ? 'draft ' : ''}package${e.packages === 1 ? '' : 's'}`];
  if (!e.paymentsReady) parts.push('Stripe not connected');
  if (!e.bookingsOpen) parts.push('bookings off');
  return parts.join(', ');
}

function storefrontRows(result: RunResult): ReactNode[][] {
  return (result as StorefrontNudgeRunResult).eligible.map((e) => [
    <div key="r" style={{ minWidth: 0 }}>
      <div style={{ fontSize: 13 }}>{e.handle ? `@${e.handle}` : e.name}</div>
      <div style={{ fontSize: 12, color: theme.textDim }}>{e.email}</div>
    </div>,
    e.audience
      ? `${e.audience.count.toLocaleString('en-US')} on ${PLATFORM_LABELS[e.audience.platform] ?? e.audience.platform}`
      : 'Under 1,000',
    <span key="s" style={{ fontSize: 12.5, color: theme.textMuted }}>
      {storefrontState(e)}
    </span>,
  ]);
}

const SWEEPS: Array<{
  key: Sweep;
  setting: keyof NotificationSettings;
  title: string;
  who: string;
  cadence: string;
  /** Sent by the Network, so it needs NETWORK_URL + NETWORK_ADMIN_API_KEY. */
  network: boolean;
  /** "N people are due {due} right now." */
  due: string;
  columns: string[];
  rows: (result: RunResult) => ReactNode[][];
}> = [
  {
    key: 'brand-setup',
    setting: 'brandSetupReminders',
    title: 'Brand setup reminders',
    who: 'Admins of live brands (pending or approved) who haven’t created a program, listed it on the marketplace, connected tracking, or (once approved) invited a partner.',
    cadence: 'Up to 3 emails: 2 days after signup, then 4 and 7 days later. Stops as soon as setup is complete or they unsubscribe.',
    network: false,
    due: 'a reminder',
    columns: ['Recipient', 'Reminder', 'Still missing'],
    rows: reminderRows,
  },
  {
    key: 'creator-profile',
    setting: 'creatorProfileReminders',
    title: 'Creator profile reminders',
    who: 'Creators who confirmed their email but are hidden from discovery because their profile is missing a handle, photo, bio, category, or social platform.',
    cadence: 'Up to 3 emails: 1 day after signup, then 3 and 7 days later. Stops as soon as the profile is complete or they unsubscribe. Sent by the Network.',
    network: true,
    due: 'a reminder',
    columns: ['Recipient', 'Reminder', 'Still missing'],
    rows: reminderRows,
  },
  {
    key: 'creator-storefront',
    setting: 'creatorStorefrontNudge',
    title: 'Creator storefront email',
    who: 'Approved creators with no open storefront who haven’t said “No thanks” to it, biggest audiences first. Shows what a storefront does, with screenshots, and quotes their follower count when their biggest channel has 1,000 or more.',
    cadence: 'One email, ever: 7 days after signup. The first run after switching it on also reaches everyone who signed up earlier. Sent by the Network.',
    network: true,
    due: 'the storefront email',
    columns: ['Recipient', 'Biggest channel', 'Storefront'],
    rows: storefrontRows,
  },
];

/**
 * Operator switches for the reminder sweeps, with a dry-run preview of
 * exactly who the next run would email and a "send now". Every sweep is
 * off until switched on here — they email real people.
 */
export function NotificationsPage({ operator }: { operator: PlatformOperator }) {
  const canWrite = operator.role === 'admin';
  const qc = useQueryClient();
  const state = useQuery({
    queryKey: ['platform-notifications'],
    queryFn: () => papi<NotificationsState>('/platform-admin/notifications'),
  });
  const save = useMutation({
    mutationFn: (patch: Partial<NotificationSettings>) =>
      papi<{ settings: NotificationSettings }>('/platform-admin/notifications', { method: 'PUT', body: patch }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['platform-notifications'] }),
  });

  return (
    <Page
      title="Notifications"
      subtitle="Reminder emails that nudge brands and creators to finish setting up. Preview who’d be emailed before switching a sweep on."
    >
      <ErrorBanner error={save.error ? friendlyPlatformError(save.error) : state.error} />
      {state.isLoading || !state.data ? (
        <Card>Loading…</Card>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {SWEEPS.map((s) => (
            <SweepCard
              key={s.key}
              sweep={s}
              enabled={state.data.settings[s.setting]}
              canWrite={canWrite}
              unavailable={s.network && !state.data.networkConfigured}
              saving={save.isPending && save.variables?.[s.setting] !== undefined}
              onToggle={(on) => save.mutate({ [s.setting]: on })}
              footnote={
                s.key === 'brand-setup'
                  ? `${state.data.brandRemindersSentLast7Days} brand reminder${state.data.brandRemindersSentLast7Days === 1 ? '' : 's'} sent in the last 7 days.`
                  : null
              }
            />
          ))}
        </div>
      )}
    </Page>
  );
}

function SweepCard({
  sweep,
  enabled,
  canWrite,
  unavailable,
  saving,
  onToggle,
  footnote,
}: {
  sweep: (typeof SWEEPS)[number];
  enabled: boolean;
  canWrite: boolean;
  unavailable: boolean;
  saving: boolean;
  onToggle: (on: boolean) => void;
  footnote: string | null;
}) {
  const [result, setResult] = useState<RunResult | null>(null);
  const run = useMutation({
    mutationFn: (dryRun: boolean) =>
      papi<RunResult>(`/platform-admin/notifications/${sweep.key}/run`, { method: 'POST', body: { dryRun } }),
    onSuccess: (r) => setResult(r),
  });

  return (
    <Card>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 15, fontWeight: 600 }}>{sweep.title}</span>
            <span
              style={{
                fontSize: 11,
                fontWeight: 600,
                padding: '3px 9px',
                borderRadius: 999,
                color: enabled ? theme.success : theme.textMuted,
                background: enabled ? theme.successSoft : theme.surface2,
              }}
            >
              {enabled ? 'on · runs daily' : 'off'}
            </span>
          </div>
          <div style={{ fontSize: 13, color: theme.textMuted, marginTop: 6, lineHeight: 1.5 }}>{sweep.who}</div>
          <div style={{ fontSize: 12.5, color: theme.textDim, marginTop: 4, lineHeight: 1.5 }}>{sweep.cadence}</div>
          {footnote && <div style={{ fontSize: 12, color: theme.textDim, marginTop: 6 }}>{footnote}</div>}
          {unavailable && (
            <div style={{ fontSize: 12.5, color: theme.warn, marginTop: 6 }}>
              NETWORK_URL / NETWORK_ADMIN_API_KEY aren’t set on this deployment, so creator emails can’t run.
            </div>
          )}
        </div>
        <div style={{ display: 'flex', gap: 8, flexShrink: 0, flexWrap: 'wrap' }}>
          <Button size="sm" variant="secondary" disabled={run.isPending || unavailable} onClick={() => run.mutate(true)}>
            {run.isPending && run.variables === true ? 'Checking…' : 'Preview next run'}
          </Button>
          {canWrite && (
            <Button
              size="sm"
              variant={enabled ? 'secondary' : 'primary'}
              disabled={saving || unavailable}
              onClick={() => onToggle(!enabled)}
            >
              {saving ? 'Saving…' : enabled ? 'Turn off' : 'Turn on'}
            </Button>
          )}
        </div>
      </div>

      {run.error && (
        <div style={{ marginTop: 12 }}>
          <ErrorBanner error={friendlyPlatformError(run.error)} />
        </div>
      )}

      {result && (
        <div style={{ marginTop: 14, borderTop: `1px solid ${theme.borderSubtle}`, paddingTop: 12 }}>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: 10,
              flexWrap: 'wrap',
              marginBottom: 10,
            }}
          >
            <div style={{ fontSize: 13, color: theme.text }}>
              {result.dryRun
                ? `${result.eligible.length} ${result.eligible.length === 1 ? 'person is' : 'people are'} due ${sweep.due} right now.`
                : `Sent ${result.sent}${result.failed ? `, ${result.failed} failed` : ''}.`}
            </div>
            {result.dryRun && canWrite && result.eligible.length > 0 && (
              <Button
                size="sm"
                disabled={run.isPending}
                onClick={() => {
                  if (window.confirm(`Email ${result.eligible.length} ${result.eligible.length === 1 ? 'person' : 'people'} now?`)) {
                    run.mutate(false);
                  }
                }}
              >
                {run.isPending && run.variables === false ? 'Sending…' : `Send ${result.eligible.length} now`}
              </Button>
            )}
          </div>
          {result.dryRun && result.eligible.length > 0 && (
            <Table columns={sweep.columns} rows={sweep.rows(result)} />
          )}
        </div>
      )}
    </Card>
  );
}
