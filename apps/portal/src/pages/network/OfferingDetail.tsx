import { useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ExternalLink, ArrowRight, Globe, Clock, DollarSign, Trophy } from 'lucide-react';
import { api, type Principal } from '../../api.js';
import { theme } from '../../theme.js';
import { Avatar, Button, Card, ErrorBanner, Input, Label, Page, SectionHeading, formatDate } from '../../ui.js';

interface OfferingDetail {
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
  vendorWebsiteUrl: string | null;
  vendorDescription: string | null;
  vendorRouterUrl?: string | null;
  vendorInstanceUrl?: string;
  terms: {
    payout:
      | { type: 'recurring_percent'; percent: number; durationMonths: number | null }
      | { type: 'one_time_fee'; amount: number; currency?: string }
      | { type: 'tiered_percent'; tiers: Array<{ minRevenueUsd: number; percent: number }> };
    cookieWindowDays: number;
    bonuses?: Array<{ description: string; triggerRevenueUsd: number; bonusUsd: number }>;
    exclusions?: string[];
  };
}

export function OfferingDetailPage({ principal }: { principal: Principal }) {
  const { id } = useParams();
  const nav = useNavigate();
  const { data, error, isLoading } = useQuery({
    queryKey: ['offering-detail', id],
    queryFn: () => api<{ offering: OfferingDetail }>(`/network/directory/offerings/${id}`),
    enabled: !!id,
  });
  const [showApply, setShowApply] = useState(false);

  const canApply = principal.role === 'network_creator';
  const defaultCode = principal.creator?.defaultPromoCode ?? principal.creator?.handle ?? '';

  if (isLoading) {
    return (
      <Page title="Offering">
        <Card>Loading…</Card>
      </Page>
    );
  }
  if (error || !data) {
    return (
      <Page title="Offering">
        <ErrorBanner error={error ?? new Error('Not found.')} />
      </Page>
    );
  }

  const o = data.offering;

  return (
    <Page
      title={o.title}
      subtitle={`By ${o.vendorName}`}
      actions={
        canApply ? (
          <Button icon={<ArrowRight size={14} />} onClick={() => setShowApply(true)}>
            Apply to promote
          </Button>
        ) : undefined
      }
    >
      <div style={{ marginBottom: 14 }}>
        <button
          onClick={() => nav(-1)}
          style={{
            background: 'transparent',
            border: 'none',
            color: theme.textMuted,
            fontSize: 12,
            cursor: 'pointer',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            padding: 0,
          }}
        >
          <ArrowLeft size={12} /> Back
        </button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 16 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <Card>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
              <Avatar name={o.vendorName} size={40} />
              <div>
                <div style={{ fontSize: 14, fontWeight: 600 }}>{o.vendorName}</div>
                <a
                  href={o.productUrl}
                  target="_blank"
                  rel="noreferrer"
                  style={{ fontSize: 12, color: theme.accent, display: 'inline-flex', alignItems: 'center', gap: 4 }}
                >
                  {o.productUrl.replace(/^https?:\/\//, '')} <ExternalLink size={11} />
                </a>
              </div>
            </div>
            {o.description && (
              <div style={{ fontSize: 14, color: theme.text, lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>
                {o.description}
              </div>
            )}
          </Card>

          <SectionHeading>Terms</SectionHeading>
          <Card>
            <TermBlock icon={<DollarSign size={16} />} label="Payout">
              <PayoutSummary payout={o.terms.payout} />
            </TermBlock>
            <TermBlock icon={<Clock size={16} />} label="Attribution window">
              <span>{o.terms.cookieWindowDays} days</span>
            </TermBlock>
            {o.terms.bonuses && o.terms.bonuses.length > 0 && (
              <TermBlock icon={<Trophy size={16} />} label="Bonuses">
                <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.7 }}>
                  {o.terms.bonuses.map((b, i) => (
                    <li key={i} style={{ color: theme.text }}>
                      <strong style={{ color: theme.warn }}>${b.bonusUsd.toLocaleString()}</strong> when revenue hits{' '}
                      <strong>${b.triggerRevenueUsd.toLocaleString()}</strong>
                      {b.description && (
                        <span style={{ color: theme.textMuted }}> — {b.description}</span>
                      )}
                    </li>
                  ))}
                </ul>
              </TermBlock>
            )}
            {o.terms.exclusions && o.terms.exclusions.length > 0 && (
              <TermBlock label="Exclusions">
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  {o.terms.exclusions.map((x, i) => (
                    <li key={i} style={{ color: theme.textMuted }}>{x}</li>
                  ))}
                </ul>
              </TermBlock>
            )}
          </Card>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <Card>
            <div style={{ fontSize: 12, fontWeight: 600, color: theme.textMuted, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 12 }}>
              About the vendor
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
              <Avatar name={o.vendorName} size={32} />
              <div style={{ fontSize: 14, fontWeight: 500 }}>{o.vendorName}</div>
            </div>
            {o.vendorDescription && (
              <div style={{ fontSize: 13, color: theme.textMuted, lineHeight: 1.6, marginBottom: 10 }}>
                {o.vendorDescription}
              </div>
            )}
            {o.vendorWebsiteUrl && (
              <a
                href={o.vendorWebsiteUrl}
                target="_blank"
                rel="noreferrer"
                style={{ fontSize: 12, color: theme.accent, display: 'inline-flex', alignItems: 'center', gap: 4 }}
              >
                <Globe size={12} /> {o.vendorWebsiteUrl.replace(/^https?:\/\//, '')}
              </a>
            )}
          </Card>

          <Card>
            <div style={{ fontSize: 12, color: theme.textMuted, marginBottom: 6 }}>Listed</div>
            <div style={{ fontSize: 14 }}>{formatDate(o.createdAt)}</div>
          </Card>

          {!canApply && (
            <Card>
              <div style={{ fontSize: 13, color: theme.textMuted, marginBottom: 10 }}>
                Want to promote this? Sign in as a creator to apply.
              </div>
              <Link to="/login" style={{ color: theme.accent, fontSize: 13, fontWeight: 500 }}>
                Sign in →
              </Link>
            </Card>
          )}
        </div>
      </div>

      {showApply && canApply && (
        <ApplyDialog offering={o} defaultCode={defaultCode} onClose={() => setShowApply(false)} />
      )}
    </Page>
  );
}

function TermBlock({ icon, label, children }: { icon?: React.ReactNode; label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr', gap: 14, padding: '10px 0', borderBottom: `1px solid ${theme.borderSubtle}` }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: theme.textMuted, fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600 }}>
        {icon}
        {label}
      </div>
      <div style={{ fontSize: 14 }}>{children}</div>
    </div>
  );
}

function PayoutSummary({ payout }: { payout: OfferingDetail['terms']['payout'] }) {
  if (payout.type === 'recurring_percent') {
    return (
      <span>
        <strong style={{ color: theme.accent }}>{payout.percent}%</strong> recurring
        {payout.durationMonths
          ? ` for ${payout.durationMonths} month${payout.durationMonths === 1 ? '' : 's'}`
          : ' for the lifetime of the customer'}
      </span>
    );
  }
  if (payout.type === 'one_time_fee') {
    return (
      <span>
        <strong style={{ color: theme.accent }}>
          ${payout.amount.toLocaleString()}
        </strong>{' '}
        one-time per referral
      </span>
    );
  }
  return (
    <div>
      <div style={{ fontWeight: 500, marginBottom: 4 }}>Tiered percent</div>
      <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, color: theme.textMuted }}>
        {payout.tiers.map((t, i) => (
          <li key={i}>
            <strong style={{ color: theme.accent }}>{t.percent}%</strong> once lifetime revenue crosses ${t.minRevenueUsd.toLocaleString()}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ApplyDialog({
  offering,
  defaultCode,
  onClose,
}: {
  offering: OfferingDetail;
  defaultCode: string;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [message, setMessage] = useState('');
  const [promoCode, setPromoCode] = useState(defaultCode);

  const codeValid = promoCode.length >= 3 && promoCode.length <= 40 && /^[a-zA-Z0-9_-]+$/.test(promoCode);
  const host = offering.vendorRouterUrl ?? ''; // prefer explicit; empty string just hides in preview

  const mut = useMutation({
    mutationFn: () =>
      api('/network/requests', {
        method: 'POST',
        body: {
          offeringId: offering.id,
          message: message || undefined,
          promoCode: promoCode || undefined,
        },
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
          width: 520,
          maxWidth: '90vw',
        }}
      >
        <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 4 }}>Apply to promote {offering.vendorName}</div>
        <div style={{ color: theme.textMuted, fontSize: 13, marginBottom: 18 }}>
          Pick a memorable share code and tell the vendor why you're a fit.
        </div>
        <ErrorBanner error={mut.error} />

        <Label>Your share code</Label>
        <Input value={promoCode} onChange={(e) => setPromoCode(e.target.value)} placeholder="graciefindsdeals" />
        {host && (
          <div style={{ fontSize: 12, color: theme.textMuted, marginTop: 6, marginBottom: 4 }}>
            Preview:{' '}
            <code style={{ color: codeValid ? theme.accent : theme.textMuted }}>
              {host}/r/{promoCode || '...'}
            </code>
          </div>
        )}
        <div style={{ fontSize: 11, color: theme.textDim, marginBottom: 16 }}>
          Letters, digits, underscores or dashes. 3–40 chars.
        </div>

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
          placeholder="Who your audience is and why you're a fit."
        />
        <div style={{ display: 'flex', gap: 8, marginTop: 16, justifyContent: 'flex-end' }}>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => mut.mutate()} disabled={!codeValid || mut.isPending}>
            {mut.isPending ? 'Sending…' : 'Send application'}
          </Button>
        </div>
      </div>
    </div>
  );
}
