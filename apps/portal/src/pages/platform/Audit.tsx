import { useQuery } from '@tanstack/react-query';
import { theme } from '../../theme.js';
import { Card, ErrorBanner, Page, formatDate } from '../../ui.js';
import { JsonPreview } from './components.js';
import { papi, type AuditEvent } from './lib.js';

/**
 * Read-only audit trail of operator actions (approvals, rejections,
 * blocklist edits), newest first.
 */
export function AuditPage() {
  const audit = useQuery({
    queryKey: ['platform-audit'],
    queryFn: () => papi<{ events: AuditEvent[] }>('/platform-admin/audit'),
  });

  const events = [...(audit.data?.events ?? [])].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );

  return (
    <Page title="Audit log" subtitle="Every operator action, newest first.">
      <ErrorBanner error={audit.error} />
      {audit.isLoading ? (
        <Card>Loading…</Card>
      ) : events.length === 0 ? (
        <Card style={{ textAlign: 'center', color: theme.textDim, fontSize: 14, padding: '40px 24px' }}>
          No audit events yet.
        </Card>
      ) : (
        <Card padded={false} style={{ overflow: 'hidden' }}>
          {events.map((e, i) => (
            <div
              key={e.id}
              style={{
                padding: '14px 18px',
                borderBottom: i < events.length - 1 ? `1px solid ${theme.borderSubtle}` : 'none',
                display: 'flex',
                flexDirection: 'column',
                gap: 4,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
                <span
                  style={{
                    fontFamily: theme.fontMono,
                    fontSize: 12.5,
                    fontWeight: 600,
                    color: theme.accent,
                  }}
                >
                  {e.action}
                </span>
                <span style={{ fontSize: 13, color: theme.textMuted }}>{e.platformAdminEmail}</span>
                {(e.targetType || e.targetId) && (
                  <span style={{ fontSize: 12, color: theme.textDim }}>
                    {e.targetType ?? 'target'}
                    {e.targetId ? ` · ${e.targetId}` : ''}
                  </span>
                )}
                <span style={{ marginLeft: 'auto', fontSize: 12, color: theme.textDim, whiteSpace: 'nowrap' }}>
                  {formatDate(e.createdAt, { relative: true })}
                </span>
              </div>
              <JsonPreview value={e.detail} />
            </div>
          ))}
        </Card>
      )}
    </Page>
  );
}
