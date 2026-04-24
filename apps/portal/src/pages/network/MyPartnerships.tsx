import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Handshake,
  Copy,
  Check,
  ExternalLink,
  MousePointerClick,
  Wallet,
  Receipt,
  AlertCircle,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import { api, type Principal } from '../../api.js';
import { theme } from '../../theme.js';
import { Card, EmptyState, ErrorBanner, Page, SectionHeading, Stat, StatusPill, formatDate, money } from '../../ui.js';

interface PartnerStats {
  partnerId: string;
  since: string;
  clicks: number;
  attributedEvents: number;
  attributedRevenue: number;
  commissionByStatus: Record<string, number>;
}

interface EarningRow {
  partnership: {
    id: string;
    vendorId: string;
    vendorName: string;
    offeringTitle: string;
    vendorLinkKey: string;
    publicShareUrl: string;
    createdAt: string;
  };
  status: 'ok' | 'error';
  error?: string;
  stats: PartnerStats | null;
}

interface EarningsResponse {
  partnerships: EarningRow[];
  totals: {
    clicks: number;
    attributedEvents: number;
    attributedRevenue: number;
    commission: { accrued: number; approved: number; paid: number; reversed: number };
    vendorCount: number;
    healthy: number;
    unreachable: number;
  };
}

export function MyPartnershipsPage({ principal }: { principal: Principal }) {
  const { data, error, isLoading } = useQuery({
    queryKey: ['network-earnings'],
    queryFn: () => api<EarningsResponse>('/network/partnerships/earnings'),
  });

  const subtitle =
    principal.role === 'network_creator'
      ? 'Live earnings from every program you promote.'
      : 'Creators currently promoting your offerings.';

  return (
    <Page title="Partnerships" subtitle={subtitle}>
      <ErrorBanner error={error} />
      {isLoading ? (
        <Card>Loading…</Card>
      ) : !data || data.partnerships.length === 0 ? (
        <EmptyState
          title="No active partnerships"
          hint="They'll appear here once a vendor approves an application."
          icon={<Handshake size={28} strokeWidth={1.25} />}
        />
      ) : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14, marginBottom: 8 }}>
            <Stat
              label="Clicks (30d)"
              value={data.totals.clicks}
              icon={<MousePointerClick size={16} />}
            />
            <Stat
              label="Attributed revenue"
              value={money(data.totals.attributedRevenue)}
              icon={<Wallet size={16} />}
              hint={`${data.totals.attributedEvents} events`}
            />
            <Stat
              label="Earned (paid)"
              value={money(data.totals.commission.paid)}
              icon={<Receipt size={16} />}
              hint={`${money(data.totals.commission.approved + data.totals.commission.accrued)} still accruing`}
            />
            <Stat
              label={principal.role === 'network_vendor' ? 'Creators' : 'Vendors'}
              value={data.totals.vendorCount}
              hint={
                data.totals.unreachable > 0
                  ? `${data.totals.unreachable} unreachable`
                  : `${data.totals.healthy} healthy`
              }
            />
          </div>

          <SectionHeading>Per partnership</SectionHeading>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))', gap: 14 }}>
            {data.partnerships.map((row) => (
              <PartnershipCard key={row.partnership.id} row={row} />
            ))}
          </div>
        </>
      )}
    </Page>
  );
}

function PartnershipCard({ row }: { row: EarningRow }) {
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const s = row.stats;

  const totalCommissionEntries =
    (s?.commissionByStatus
      ? Object.values(s.commissionByStatus).reduce((a, b) => a + (b > 0 ? 1 : 0), 0)
      : 0);

  return (
    <Card>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 13, color: theme.textMuted, marginBottom: 2 }}>{row.partnership.vendorName}</div>
          <div style={{ fontSize: 15, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {row.partnership.offeringTitle}
          </div>
        </div>
        <StatusPill status="active" />
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          background: theme.bg,
          border: `1px solid ${theme.borderSubtle}`,
          padding: '8px 10px',
          borderRadius: theme.radiusSm,
          marginBottom: 12,
        }}
      >
        <code style={{ flex: 1, fontSize: 12, color: theme.accent, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {row.partnership.publicShareUrl}
        </code>
        <button
          onClick={() => {
            navigator.clipboard.writeText(row.partnership.publicShareUrl);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
          style={{
            background: 'transparent',
            border: `1px solid ${theme.border}`,
            color: copied ? theme.success : theme.textMuted,
            padding: '4px 8px',
            borderRadius: theme.radiusSm,
            cursor: 'pointer',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            fontSize: 11,
          }}
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
          {copied ? 'Copied' : 'Copy'}
        </button>
        <a
          href={row.partnership.publicShareUrl}
          target="_blank"
          rel="noreferrer"
          style={{ color: theme.textMuted, display: 'inline-flex', alignItems: 'center' }}
        >
          <ExternalLink size={13} />
        </a>
      </div>

      {row.status === 'error' ? (
        <div
          style={{
            background: theme.dangerSoft,
            color: theme.danger,
            padding: '8px 12px',
            borderRadius: theme.radiusSm,
            fontSize: 12,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
          }}
        >
          <AlertCircle size={14} />
          <div>
            <div style={{ fontWeight: 500 }}>Vendor unreachable</div>
            <div style={{ color: `${theme.danger}aa`, marginTop: 2 }}>{row.error}</div>
          </div>
        </div>
      ) : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
            <MiniStat label="Clicks" value={s?.clicks ?? 0} />
            <MiniStat label="Revenue" value={money(s?.attributedRevenue ?? 0)} />
            <MiniStat label="Paid" value={money(s?.commissionByStatus.paid ?? 0)} tint={theme.success} />
          </div>
          {totalCommissionEntries > 0 && (
            <>
              <button
                onClick={() => setExpanded((v) => !v)}
                style={{
                  marginTop: 12,
                  background: 'transparent',
                  border: 'none',
                  color: theme.textMuted,
                  padding: 0,
                  fontSize: 12,
                  cursor: 'pointer',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                }}
              >
                {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                {expanded ? 'Hide' : 'View'} commission history
              </button>
              {expanded && <CommissionDrilldown partnershipId={row.partnership.id} />}
            </>
          )}
        </>
      )}

      <div style={{ fontSize: 11, color: theme.textDim, marginTop: 10 }}>
        Started {formatDate(row.partnership.createdAt, { relative: true })}
      </div>
    </Card>
  );
}

interface Commission {
  id: string;
  amount: string;
  currency: string;
  status: string;
  accruedAt: string;
  paidAt: string | null;
}

function CommissionDrilldown({ partnershipId }: { partnershipId: string }) {
  const { data, error, isLoading } = useQuery({
    queryKey: ['network-partnership-commissions', partnershipId],
    queryFn: () => api<{ commissions: Commission[] }>(`/network/partnerships/${partnershipId}/commissions`),
  });

  if (isLoading) {
    return <div style={{ color: theme.textDim, fontSize: 12, marginTop: 10 }}>Loading…</div>;
  }
  if (error) {
    return (
      <div style={{ color: theme.danger, fontSize: 12, marginTop: 10 }}>
        {error instanceof Error ? error.message : 'Could not load commission history.'}
      </div>
    );
  }
  const rows = data?.commissions ?? [];
  if (rows.length === 0) {
    return <div style={{ color: theme.textDim, fontSize: 12, marginTop: 10 }}>No commissions yet.</div>;
  }

  return (
    <div
      style={{
        marginTop: 10,
        background: theme.bg,
        border: `1px solid ${theme.borderSubtle}`,
        borderRadius: theme.radiusSm,
        overflow: 'hidden',
        maxHeight: 240,
        overflowY: 'auto',
      }}
    >
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
        <thead>
          <tr style={{ background: theme.surface2 }}>
            <th style={headerCellStyle}>Status</th>
            <th style={{ ...headerCellStyle, textAlign: 'right' }}>Amount</th>
            <th style={headerCellStyle}>Accrued</th>
            <th style={headerCellStyle}>Paid</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((c, i) => (
            <tr key={c.id} style={{ borderBottom: i < rows.length - 1 ? `1px solid ${theme.borderSubtle}` : 'none' }}>
              <td style={cellStyle}>
                <StatusPill status={c.status} />
              </td>
              <td style={{ ...cellStyle, textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: 500 }}>
                {money(c.amount, c.currency)}
              </td>
              <td style={{ ...cellStyle, color: theme.textMuted }}>
                {formatDate(c.accruedAt, { relative: true })}
              </td>
              <td style={{ ...cellStyle, color: theme.textMuted }}>
                {formatDate(c.paidAt, { relative: true })}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const headerCellStyle = {
  padding: '8px 10px',
  textAlign: 'left' as const,
  color: theme.textMuted,
  fontSize: 10,
  fontWeight: 600,
  textTransform: 'uppercase' as const,
  letterSpacing: '0.05em',
};

const cellStyle = {
  padding: '8px 10px',
};

function MiniStat({ label, value, tint }: { label: string; value: string | number; tint?: string }) {
  return (
    <div>
      <div style={{ fontSize: 10, color: theme.textMuted, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 2 }}>
        {label}
      </div>
      <div style={{ fontSize: 14, fontWeight: 500, fontVariantNumeric: 'tabular-nums', color: tint ?? theme.text }}>{value}</div>
    </div>
  );
}
