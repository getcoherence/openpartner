import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Handshake, Copy, Check, ExternalLink } from 'lucide-react';
import { api, type Principal } from '../../api.js';
import { theme } from '../../theme.js';
import { Card, EmptyState, ErrorBanner, Page, StatusPill, formatDate } from '../../ui.js';

interface Partnership {
  id: string;
  offeringId: string;
  vendorId: string;
  creatorId: string;
  vendorPartnerId: string;
  vendorLinkKey: string;
  publicShareUrl: string;
  status: string;
  createdAt: string;
}

export function MyPartnershipsPage({ principal }: { principal: Principal }) {
  const { data, error, isLoading } = useQuery({
    queryKey: ['network-partnerships-mine'],
    queryFn: () => api<{ partnerships: Partnership[] }>('/network/partnerships/mine'),
  });

  const subtitle =
    principal.role === 'network_creator'
      ? 'Active partnerships and your personal share links.'
      : 'Active partnerships with creators.';

  return (
    <Page title="Partnerships" subtitle={subtitle}>
      <ErrorBanner error={error} />
      {isLoading ? (
        <Card>Loading…</Card>
      ) : (data?.partnerships ?? []).length === 0 ? (
        <EmptyState title="No active partnerships" hint="They'll appear here once a vendor approves your application." icon={<Handshake size={28} strokeWidth={1.25} />} />
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))', gap: 14 }}>
          {(data?.partnerships ?? []).map((p) => (
            <PartnershipCard key={p.id} partnership={p} />
          ))}
        </div>
      )}
    </Page>
  );
}

function PartnershipCard({ partnership }: { partnership: Partnership }) {
  const [copied, setCopied] = useState(false);
  return (
    <Card>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
        <div>
          <div style={{ fontSize: 13, color: theme.textMuted, marginBottom: 4 }}>Partnership</div>
          <code style={{ fontSize: 12, color: theme.textDim }}>{partnership.id.slice(0, 12)}…</code>
        </div>
        <StatusPill status={partnership.status} />
      </div>
      <div style={{ fontSize: 12, color: theme.textMuted, marginBottom: 6 }}>Your share link</div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          background: theme.bg,
          border: `1px solid ${theme.borderSubtle}`,
          padding: '10px 12px',
          borderRadius: theme.radiusSm,
          marginBottom: 12,
        }}
      >
        <code style={{ flex: 1, fontSize: 12, color: theme.accent, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {partnership.publicShareUrl}
        </code>
        <button
          onClick={() => {
            navigator.clipboard.writeText(partnership.publicShareUrl);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
          style={{
            background: 'transparent',
            border: `1px solid ${theme.border}`,
            color: copied ? theme.success : theme.textMuted,
            padding: '6px 8px',
            borderRadius: theme.radiusSm,
            cursor: 'pointer',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            fontSize: 12,
          }}
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
          {copied ? 'Copied' : 'Copy'}
        </button>
        <a
          href={partnership.publicShareUrl}
          target="_blank"
          rel="noreferrer"
          style={{ color: theme.textMuted, display: 'inline-flex', alignItems: 'center' }}
        >
          <ExternalLink size={13} />
        </a>
      </div>
      <div style={{ fontSize: 12, color: theme.textDim }}>Started {formatDate(partnership.createdAt, { relative: true })}</div>
    </Card>
  );
}
