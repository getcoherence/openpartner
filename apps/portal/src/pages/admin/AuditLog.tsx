import { useState } from 'react';
import { keepPreviousData, useInfiniteQuery, useMutation, useQuery } from '@tanstack/react-query';
import { Download, History } from 'lucide-react';
import { api, apiDownload } from '../../api.js';
import { theme } from '../../theme.js';
import { Button, Card, EmptyState, ErrorBanner, Page, Select, Table, formatDate } from '../../ui.js';

const PAGE_SIZE = 50;

export interface AuditEntry {
  id: string;
  createdAt: string;
  actorKind: 'admin' | 'api_key' | 'operator_key';
  actorId: string | null;
  actorLabel: string | null;
  action: string;
  label: string | null;
  targetId: string | null;
  targetName: string | null;
  fields: string[] | null;
  detail: { changes?: Record<string, { from: unknown; to: unknown }>; via?: string } | null;
  status: number | null;
  ip: string | null;
}

interface Actor {
  actorId: string;
  actorKind: AuditEntry['actorKind'];
  actorLabel: string | null;
}

const VIA: Record<string, string> = {
  link: 'with an email link or password',
  workspace: 'from their OpenPartner account',
  claim: 'on signing up',
};

export function AdminAuditLog() {
  const [actorId, setActorId] = useState('');

  const actors = useQuery({
    queryKey: ['audit-log-actors'],
    queryFn: () => api<{ actors: Actor[] }>('/audit-log/actors'),
  });

  const { data, error, isLoading, fetchNextPage, hasNextPage, isFetchingNextPage } = useInfiniteQuery({
    queryKey: ['audit-log', actorId],
    queryFn: ({ pageParam }) => {
      const qs = new URLSearchParams({ limit: String(PAGE_SIZE) });
      if (actorId) qs.set('actorId', actorId);
      if (pageParam) qs.set('cursor', pageParam);
      return api<{ entries: AuditEntry[]; nextCursor: string | null }>(`/audit-log?${qs}`);
    },
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    // Changing the filter keeps the rows on screen until the new ones land.
    placeholderData: keepPreviousData,
  });

  const download = useMutation({
    mutationFn: () => apiDownload(`/audit-log.csv${actorId ? `?actorId=${encodeURIComponent(actorId)}` : ''}`, 'audit-log.csv'),
  });

  const entries = data?.pages.flatMap((p) => p.entries) ?? [];

  return (
    <Page
      title="Audit log"
      actions={
        <>
          <Select value={actorId} onChange={(e) => setActorId(e.target.value)} aria-label="Who" style={{ width: 'auto', minWidth: 200 }}>
            <option value="">Everyone</option>
            {(actors.data?.actors ?? []).map((a) => (
              <option key={a.actorId} value={a.actorId}>
                {a.actorKind === 'api_key' ? `API key: ${a.actorLabel ?? a.actorId}` : (a.actorLabel ?? a.actorId)}
              </option>
            ))}
          </Select>
          <Button variant="secondary" icon={<Download size={14} />} onClick={() => download.mutate()} disabled={download.isPending}>
            {download.isPending ? 'Downloading…' : 'Download CSV'}
          </Button>
        </>
      }
    >
      <ErrorBanner error={error ?? download.error} />
      {isLoading ? (
        <Card>Loading…</Card>
      ) : entries.length === 0 ? (
        <EmptyState title="Nothing yet" icon={<History size={28} strokeWidth={1.25} />} />
      ) : (
        <>
          <Table
            resizeKey="audit-log"
            columns={['When', 'Who', 'Action', 'Details', 'IP']}
            rows={entries.map((e) => [
              <span title={new Date(e.createdAt).toLocaleString()} style={{ color: theme.textMuted, whiteSpace: 'nowrap' }}>
                {formatDate(e.createdAt, { relative: true })}
              </span>,
              <Who entry={e} />,
              <Action entry={e} />,
              <Details entry={e} />,
              <span style={{ color: theme.textDim, fontSize: 12 }}>{e.ip ?? '—'}</span>,
            ])}
          />
          {hasNextPage && (
            <div style={{ display: 'flex', justifyContent: 'center', marginTop: 16 }}>
              <Button variant="secondary" size="sm" onClick={() => void fetchNextPage()} disabled={isFetchingNextPage}>
                {isFetchingNextPage ? 'Loading…' : `Load ${PAGE_SIZE} more`}
              </Button>
            </div>
          )}
        </>
      )}
    </Page>
  );
}

function Who({ entry }: { entry: AuditEntry }) {
  if (entry.actorKind === 'operator_key') return <span style={{ color: theme.textMuted }}>Operator key</span>;
  const name = entry.actorLabel ?? entry.actorId ?? '—';
  if (entry.actorKind === 'admin') return <span>{name}</span>;
  return (
    <span>
      <span style={{ color: theme.textMuted }}>API key </span>
      {name}
    </span>
  );
}

function Action({ entry }: { entry: AuditEntry }) {
  return (
    <span>
      {entry.label ?? <code style={{ fontSize: 12 }}>{entry.action}</code>}
      {entry.targetName && <span style={{ color: theme.textMuted }}> · {entry.targetName}</span>}
    </span>
  );
}

/** A value from a change, short enough for a cell; the whole of it in the title. */
function shown(v: unknown): string {
  if (v === null || v === undefined || v === '') return '—';
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > 60 ? `${s.slice(0, 57)}…` : s;
}

function Details({ entry }: { entry: AuditEntry }) {
  const changes = entry.detail?.changes;
  if (changes && Object.keys(changes).length > 0) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, fontSize: 13 }}>
        {Object.entries(changes).map(([field, { from, to }]) => (
          <span key={field} title={`${JSON.stringify(from)} → ${JSON.stringify(to)}`}>
            <span style={{ color: theme.textMuted }}>{field}:</span> {shown(from)} → {shown(to)}
          </span>
        ))}
      </div>
    );
  }
  if (entry.action === 'signin' && entry.detail?.via) {
    return <span style={{ color: theme.textMuted }}>{VIA[entry.detail.via] ?? entry.detail.via}</span>;
  }
  if (entry.fields?.length) {
    return <span style={{ color: theme.textMuted, fontSize: 13 }}>{entry.fields.join(', ')}</span>;
  }
  return <span style={{ color: theme.textDim }}>—</span>;
}
