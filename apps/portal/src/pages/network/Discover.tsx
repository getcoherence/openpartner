import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Compass, ExternalLink, ArrowRight } from 'lucide-react';
import { api, type Principal } from '../../api.js';
import { theme } from '../../theme.js';
import { Avatar, Button, Card, EmptyState, ErrorBanner, Input, Label, Page } from '../../ui.js';

interface DirOffering {
  id: string;
  title: string;
  description: string | null;
  heroImageUrl: string | null;
  productUrl: string;
  createdAt: string;
  vendorId: string;
  vendorName: string;
  vendorSlug: string;
  vendorLogoUrl: string | null;
  terms: {
    payout:
      | { type: 'recurring_percent'; percent: number; durationMonths: number | null }
      | { type: 'one_time_fee'; amount: number; currency?: string }
      | { type: 'tiered_percent'; tiers: Array<{ minRevenueUsd: number; percent: number }> };
    cookieWindowDays: number;
    bonuses?: Array<{ description: string; triggerRevenueUsd: number; bonusUsd: number }>;
  };
}

export function DiscoverPage({ principal }: { principal: Principal }) {
  const { data, error, isLoading } = useQuery({
    queryKey: ['network-directory-offerings'],
    queryFn: () => api<{ offerings: DirOffering[] }>('/network/directory/offerings'),
  });

  return (
    <Page title="Discover" subtitle="Offerings from every active vendor on the Network.">
      <ErrorBanner error={error} />
      {isLoading ? (
        <Card>Loading…</Card>
      ) : (data?.offerings ?? []).length === 0 ? (
        <EmptyState
          title="Nothing here yet"
          hint="Vendors haven't published their offerings yet."
          icon={<Compass size={28} strokeWidth={1.25} />}
        />
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 16 }}>
          {(data?.offerings ?? []).map((o) => (
            <OfferingCard key={o.id} offering={o} canApply={principal.role === 'network_creator'} />
          ))}
        </div>
      )}
    </Page>
  );
}

function OfferingCard({ offering, canApply }: { offering: DirOffering; canApply: boolean }) {
  const [showApply, setShowApply] = useState(false);
  return (
    <Card>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
        <Avatar name={offering.vendorName} size={28} />
        <div style={{ fontSize: 12, color: theme.textMuted }}>{offering.vendorName}</div>
      </div>
      <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 6 }}>{offering.title}</div>
      {offering.description && (
        <div style={{ fontSize: 13, color: theme.textMuted, marginBottom: 12, lineHeight: 1.5 }}>
          {offering.description}
        </div>
      )}
      <TermsSummary terms={offering.terms} />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 16 }}>
        <a
          href={offering.productUrl}
          target="_blank"
          rel="noreferrer"
          style={{ color: theme.textMuted, fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 4 }}
        >
          Product <ExternalLink size={12} />
        </a>
        {canApply && (
          <Button size="sm" icon={<ArrowRight size={13} />} onClick={() => setShowApply(true)}>
            Apply
          </Button>
        )}
      </div>
      {showApply && <ApplyDialog offeringId={offering.id} onClose={() => setShowApply(false)} />}
    </Card>
  );
}

function TermsSummary({ terms }: { terms: DirOffering['terms'] }) {
  const { payout } = terms;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 12, background: theme.bg, borderRadius: theme.radiusSm }}>
      <div style={{ fontSize: 13 }}>
        <strong style={{ color: theme.accent }}>
          {payout.type === 'recurring_percent' && `${payout.percent}% recurring`}
          {payout.type === 'one_time_fee' && `$${payout.amount} one-time`}
          {payout.type === 'tiered_percent' && 'Tiered %'}
        </strong>
        {payout.type === 'recurring_percent' && (
          <span style={{ color: theme.textMuted }}>
            {' '}
            {payout.durationMonths ? `for ${payout.durationMonths} months` : '(lifetime)'}
          </span>
        )}
      </div>
      <div style={{ fontSize: 12, color: theme.textMuted }}>{terms.cookieWindowDays}-day attribution window</div>
      {terms.bonuses?.map((b, i) => (
        <div key={i} style={{ fontSize: 12, color: theme.warn }}>
          🎯 ${b.bonusUsd} bonus at ${b.triggerRevenueUsd.toLocaleString()} MRR
        </div>
      ))}
    </div>
  );
}

function ApplyDialog({ offeringId, onClose }: { offeringId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const [message, setMessage] = useState('');
  const mut = useMutation({
    mutationFn: () =>
      api('/network/requests', {
        method: 'POST',
        body: { offeringId, message },
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['network-requests-mine'] });
      onClose();
    },
  });

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.6)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 50,
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: theme.surface,
          border: `1px solid ${theme.border}`,
          borderRadius: theme.radiusLg,
          padding: 24,
          width: 480,
          maxWidth: '90vw',
        }}
      >
        <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 8 }}>Apply to promote</div>
        <div style={{ color: theme.textMuted, fontSize: 13, marginBottom: 16 }}>
          Tell the vendor why you're a fit — audience, niche, channels.
        </div>
        <ErrorBanner error={mut.error} />
        <Label>Message (optional)</Label>
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          rows={5}
          style={{
            width: '100%',
            padding: '10px 12px',
            fontSize: 14,
            background: theme.surface2,
            border: `1px solid ${theme.border}`,
            borderRadius: theme.radiusSm,
            color: theme.text,
            fontFamily: theme.fontSans,
            resize: 'vertical',
          }}
          placeholder="120k YouTube subs in the indie-hacker niche, mostly US + EU."
        />
        <div style={{ display: 'flex', gap: 8, marginTop: 16, justifyContent: 'flex-end' }}>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => mut.mutate()} disabled={mut.isPending}>
            {mut.isPending ? 'Sending…' : 'Send application'}
          </Button>
        </div>
      </div>
    </div>
  );
}
