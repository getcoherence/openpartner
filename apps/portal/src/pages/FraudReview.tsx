import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ShieldAlert, ShieldOff, Check } from 'lucide-react';
import { api } from '../api.js';
import { theme } from '../theme.js';
import { Button, Card, EmptyState, ErrorBanner, Page, StatusPill, Table, formatDate, shortId } from '../ui.js';

interface FlaggedClick {
  id: string;
  fraudFlag: 'velocity' | 'manual';
  ts: string;
  ipHash: string | null;
  userAgent: string | null;
  referer: string | null;
  landingUrl: string;
  partnerId: string;
  partnerName: string | null;
  linkId: string | null;
  linkKey: string | null;
}

export function FraudReviewPage() {
  const qc = useQueryClient();
  const { data, error, isLoading } = useQuery({
    queryKey: ['fraud-flagged'],
    queryFn: () => api<{ clicks: FlaggedClick[] }>('/admin/clicks/flagged?limit=500'),
  });

  const unflag = useMutation({
    mutationFn: (id: string) => api<{ reattributedEvents: number }>(`/clicks/${id}/unflag`, { method: 'POST' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['fraud-flagged'] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
      qc.invalidateQueries({ queryKey: ['funnel'] });
    },
  });

  const rows = data?.clicks ?? [];

  return (
    <Page
      title="Fraud review"
      subtitle={`${rows.length} flagged click${rows.length === 1 ? '' : 's'} — attribution skips these until you un-flag.`}
    >
      <ErrorBanner error={error ?? unflag.error} />
      {unflag.data && (
        <Card style={{ marginBottom: 14, borderColor: `${theme.success}55` }}>
          <div style={{ color: theme.success, fontSize: 13, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <Check size={14} />
            Un-flagged. Re-attributed {unflag.data.reattributedEvents} event
            {unflag.data.reattributedEvents === 1 ? '' : 's'} that landed while the click was skipped.
          </div>
        </Card>
      )}
      {isLoading ? (
        <Card>Loading…</Card>
      ) : rows.length === 0 ? (
        <EmptyState
          title="No flagged clicks"
          hint="Clicks get flagged automatically when they exceed the router's velocity limits, or manually from this view."
          icon={<ShieldAlert size={28} strokeWidth={1.25} />}
        />
      ) : (
        <Table
          columns={['ID', 'Partner', 'Link', 'IP hash', 'Reason', 'Clicked', 'Actions']}
          rows={rows.map((c) => [
            <code style={{ fontSize: 12, color: theme.textDim }}>{shortId(c.id)}</code>,
            <span>{c.partnerName ?? <code style={{ color: theme.textDim, fontSize: 12 }}>{shortId(c.partnerId)}</code>}</span>,
            c.linkKey ? <code style={{ fontSize: 12, color: theme.accent }}>/r/{c.linkKey}</code> : <span style={{ color: theme.textDim }}>—</span>,
            c.ipHash ? <code style={{ fontSize: 11, color: theme.textMuted }}>{c.ipHash.slice(0, 12)}…</code> : <span style={{ color: theme.textDim }}>—</span>,
            <StatusPill status={c.fraudFlag} />,
            <span style={{ color: theme.textMuted }}>{formatDate(c.ts, { relative: true })}</span>,
            <Button
              size="sm"
              variant="secondary"
              icon={<ShieldOff size={12} />}
              onClick={() => unflag.mutate(c.id)}
              disabled={unflag.isPending}
            >
              Un-flag
            </Button>,
          ])}
        />
      )}
    </Page>
  );
}
