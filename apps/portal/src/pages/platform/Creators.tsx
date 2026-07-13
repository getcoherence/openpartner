import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { theme } from '../../theme.js';
import { Button, Card, ErrorBanner, Page, formatDate } from '../../ui.js';
import {
  papi,
  friendlyPlatformError,
  type NetworkCreator,
  type PlatformOperator,
} from './lib.js';

type Filter = 'all' | 'blocked' | 'incomplete';

const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'incomplete', label: 'Incomplete' },
  { key: 'blocked', label: 'Blocked' },
];

/**
 * Network creators (partners). These live on the Network coordinator, not in
 * any one brand's database — a creator is ONE identity across every brand, so
 * blocking here removes them network-wide (hidden from marketplace discovery
 * + their public profile, and signed out everywhere). A brand removing a
 * partner from just its own roster is a separate, brand-level action.
 */
export function CreatorsPage({ operator }: { operator: PlatformOperator }) {
  const [filter, setFilter] = useState<Filter>('all');
  const qc = useQueryClient();
  const canWrite = operator.role === 'admin';

  const creators = useQuery({
    queryKey: ['platform-creators'],
    queryFn: () => papi<{ creators: NetworkCreator[] }>('/platform-admin/creators'),
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ['platform-creators'] });

  const block = useMutation({
    mutationFn: (v: { id: string; reason: string }) =>
      papi(`/platform-admin/creators/${v.id}/block`, { method: 'POST', body: { reason: v.reason } }),
    onSuccess: invalidate,
  });
  const unblock = useMutation({
    mutationFn: (id: string) => papi(`/platform-admin/creators/${id}/unblock`, { method: 'POST' }),
    onSuccess: invalidate,
  });

  const all = creators.data?.creators ?? [];
  const rows = all.filter((c) =>
    filter === 'blocked' ? c.status === 'blocked' : filter === 'incomplete' ? !c.profileComplete : true,
  );
  const actionError = block.error ?? unblock.error;

  return (
    <Page
      title="Creators"
      subtitle="Network-wide partner identities. Blocking removes a creator from the marketplace everywhere, not just one brand."
    >
      <div style={{ display: 'flex', gap: 6, marginBottom: 18, flexWrap: 'wrap' }}>
        {FILTERS.map((f) => {
          const active = filter === f.key;
          const count =
            f.key === 'blocked'
              ? all.filter((c) => c.status === 'blocked').length
              : f.key === 'incomplete'
                ? all.filter((c) => !c.profileComplete).length
                : all.length;
          return (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              style={{
                padding: '7px 14px',
                borderRadius: 999,
                fontSize: 13,
                fontWeight: active ? 600 : 500,
                cursor: 'pointer',
                color: active ? theme.accentInk : theme.textMuted,
                background: active ? theme.accent : theme.surface2,
                border: `1px solid ${active ? theme.accent : theme.border}`,
              }}
            >
              {f.label} ({count})
            </button>
          );
        })}
      </div>

      {!canWrite && (
        <div
          style={{
            background: theme.infoSoft,
            border: `1px solid ${theme.info}44`,
            color: theme.info,
            padding: '10px 14px',
            borderRadius: theme.radiusSm,
            fontSize: 13,
            marginBottom: 16,
          }}
        >
          You’re signed in as a read-only operator. Blocking is disabled.
        </div>
      )}

      <ErrorBanner error={actionError ? friendlyPlatformError(actionError) : creators.error} />

      {creators.isLoading ? (
        <Card>Loading…</Card>
      ) : rows.length === 0 ? (
        <Card style={{ textAlign: 'center', color: theme.textDim, fontSize: 14, padding: '40px 24px' }}>
          No {filter === 'all' ? '' : filter} creators.
        </Card>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {rows.map((c) => (
            <CreatorCard
              key={c.id}
              creator={c}
              canWrite={canWrite}
              busy={
                (block.isPending && block.variables?.id === c.id) ||
                (unblock.isPending && unblock.variables === c.id)
              }
              onBlock={(reason) => block.mutate({ id: c.id, reason })}
              onUnblock={() => unblock.mutate(c.id)}
            />
          ))}
        </div>
      )}
    </Page>
  );
}

function CreatorCard({
  creator: c,
  canWrite,
  busy,
  onBlock,
  onUnblock,
}: {
  creator: NetworkCreator;
  canWrite: boolean;
  busy: boolean;
  onBlock: (reason: string) => void;
  onUnblock: () => void;
}) {
  const blocked = c.status === 'blocked';
  return (
    <Card>
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <Avatar url={c.avatarUrl} name={c.name} />

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 15, fontWeight: 600 }}>{c.name}</span>
            {c.handle && (
              <span style={{ fontSize: 12.5, color: theme.textDim, fontFamily: theme.fontMono }}>@{c.handle}</span>
            )}
            {blocked && <Pill tone="danger">Blocked</Pill>}
            {!c.profileComplete && !blocked && <Pill tone="warn">Incomplete — hidden from discovery</Pill>}
          </div>

          <div style={{ fontSize: 12.5, color: theme.textMuted, marginTop: 3 }}>{c.email}</div>

          {c.bio && (
            <div
              style={{
                fontSize: 12.5,
                color: theme.textDim,
                marginTop: 6,
                display: '-webkit-box',
                WebkitLineClamp: 2,
                WebkitBoxOrient: 'vertical',
                overflow: 'hidden',
              }}
            >
              {c.bio}
            </div>
          )}

          <div style={{ fontSize: 11.5, color: theme.textDim, marginTop: 6 }}>
            {c.affiliationCount} brand{c.affiliationCount === 1 ? '' : 's'} · {c.platformCount} platform
            {c.platformCount === 1 ? '' : 's'} · joined {formatDate(c.createdAt)}
            {c.categories.length > 0 ? ` · ${c.categories.join(', ')}` : ''}
          </div>

          {!c.profileComplete && c.profileMissing.length > 0 && (
            <div style={{ fontSize: 11.5, color: theme.warn, marginTop: 6 }}>
              Missing: {c.profileMissing.map((m) => m.label).join(' · ')}
            </div>
          )}

          {blocked && (
            <div style={{ fontSize: 11.5, color: theme.danger, marginTop: 6 }}>
              {c.blockedReason ? `Reason: ${c.blockedReason}` : 'Blocked'}
              {c.blockedByEmail ? ` · by ${c.blockedByEmail}` : ''}
              {c.blockedAt ? ` · ${formatDate(c.blockedAt)}` : ''}
            </div>
          )}
        </div>

        {canWrite && (
          <div style={{ flexShrink: 0 }}>
            {blocked ? (
              <Button size="sm" disabled={busy} onClick={onUnblock}>
                {busy ? 'Working…' : 'Unblock'}
              </Button>
            ) : (
              <Button
                variant="danger"
                size="sm"
                disabled={busy}
                onClick={() => {
                  const reason = window.prompt(
                    `Block ${c.name}? They'll be removed from the marketplace across every brand and signed out.\n\nReason (required):`,
                    '',
                  );
                  if (reason && reason.trim()) onBlock(reason.trim());
                }}
              >
                {busy ? 'Working…' : 'Block'}
              </Button>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}

function Avatar({ url, name }: { url: string | null; name: string }) {
  if (url) {
    return (
      <img
        src={url}
        alt=""
        style={{ width: 40, height: 40, borderRadius: '50%', objectFit: 'cover', background: theme.surface2 }}
      />
    );
  }
  return (
    <div
      aria-hidden
      style={{
        width: 40,
        height: 40,
        borderRadius: '50%',
        background: theme.surface2,
        color: theme.textDim,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 15,
        fontWeight: 600,
        flexShrink: 0,
      }}
    >
      {(name.trim()[0] ?? '?').toUpperCase()}
    </div>
  );
}

function Pill({ tone, children }: { tone: 'danger' | 'warn'; children: React.ReactNode }) {
  const color = tone === 'danger' ? theme.danger : theme.warn;
  return (
    <span
      style={{
        fontSize: 10.5,
        fontWeight: 700,
        textTransform: 'uppercase',
        letterSpacing: '0.04em',
        color,
        background: `${color}1a`,
        borderRadius: 4,
        padding: '2px 6px',
      }}
    >
      {children}
    </span>
  );
}
