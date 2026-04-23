import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Package2, ExternalLink } from 'lucide-react';
import { api } from '../../api.js';
import { theme } from '../../theme.js';
import { Button, Card, EmptyState, ErrorBanner, Input, Label, Page, Select, StatusPill, formatDate } from '../../ui.js';

interface Offering {
  id: string;
  title: string;
  productUrl: string;
  description: string | null;
  vendorCampaignId: string;
  terms: {
    payout:
      | { type: 'recurring_percent'; percent: number; durationMonths: number | null }
      | { type: 'one_time_fee'; amount: number; currency?: string }
      | { type: 'tiered_percent'; tiers: Array<{ minRevenueUsd: number; percent: number }> };
    cookieWindowDays: number;
    bonuses?: Array<{ description: string; triggerRevenueUsd: number; bonusUsd: number }>;
  };
  published: boolean;
  createdAt: string;
  updatedAt: string;
}

export function VendorOfferingsPage() {
  const qc = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);
  const { data, error, isLoading } = useQuery({
    queryKey: ['network-offerings-mine'],
    queryFn: () => api<{ offerings: Offering[] }>('/network/offerings/mine'),
  });

  const togglePublish = useMutation({
    mutationFn: (o: Offering) =>
      api(`/network/offerings/${o.id}`, { method: 'PATCH', body: { published: !o.published } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['network-offerings-mine'] }),
  });

  return (
    <Page
      title="My offerings"
      subtitle="Publish referral programs creators can discover."
      actions={
        <Button icon={<Plus size={14} />} onClick={() => setShowCreate(true)}>
          New offering
        </Button>
      }
    >
      <ErrorBanner error={error ?? togglePublish.error} />
      {showCreate && (
        <CreateOffering
          onClose={() => setShowCreate(false)}
          onCreated={() => {
            setShowCreate(false);
            qc.invalidateQueries({ queryKey: ['network-offerings-mine'] });
          }}
        />
      )}
      {isLoading ? (
        <Card>Loading…</Card>
      ) : (data?.offerings ?? []).length === 0 ? (
        <EmptyState title="No offerings yet" hint="Publish one to appear in the Network directory." icon={<Package2 size={28} strokeWidth={1.25} />} />
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: 14 }}>
          {(data?.offerings ?? []).map((o) => (
            <Card key={o.id}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 }}>
                <div style={{ fontSize: 15, fontWeight: 600 }}>{o.title}</div>
                <StatusPill status={o.published ? 'connected' : 'pending'} />
              </div>
              {o.description && (
                <div style={{ fontSize: 13, color: theme.textMuted, marginBottom: 10, lineHeight: 1.5 }}>{o.description}</div>
              )}
              <div style={{ fontSize: 12, color: theme.textDim, marginBottom: 12 }}>
                <TermsLine terms={o.terms} />
                <div style={{ marginTop: 4 }}>
                  Campaign: <code style={{ color: theme.textMuted }}>{o.vendorCampaignId.slice(0, 12)}…</code>
                </div>
                <div style={{ marginTop: 4 }}>Created {formatDate(o.createdAt, { relative: true })}</div>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <Button
                  size="sm"
                  variant={o.published ? 'secondary' : 'primary'}
                  onClick={() => togglePublish.mutate(o)}
                  disabled={togglePublish.isPending}
                >
                  {o.published ? 'Unpublish' : 'Publish'}
                </Button>
                <a
                  href={o.productUrl}
                  target="_blank"
                  rel="noreferrer"
                  style={{ fontSize: 12, color: theme.textMuted, display: 'inline-flex', alignItems: 'center', gap: 4, alignSelf: 'center' }}
                >
                  Product <ExternalLink size={12} />
                </a>
              </div>
            </Card>
          ))}
        </div>
      )}
    </Page>
  );
}

function TermsLine({ terms }: { terms: Offering['terms'] }) {
  const p = terms.payout;
  if (p.type === 'recurring_percent') {
    return <span>{p.percent}% recurring{p.durationMonths ? ` for ${p.durationMonths} months` : ' (lifetime)'} · {terms.cookieWindowDays}-day cookie</span>;
  }
  if (p.type === 'one_time_fee') return <span>${p.amount} one-time · {terms.cookieWindowDays}-day cookie</span>;
  return <span>Tiered % · {terms.cookieWindowDays}-day cookie</span>;
}

function CreateOffering({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [title, setTitle] = useState('');
  const [productUrl, setProductUrl] = useState('');
  const [description, setDescription] = useState('');
  const [vendorCampaignId, setVendorCampaignId] = useState('');
  const [payoutType, setPayoutType] = useState<'recurring_percent' | 'one_time_fee'>('recurring_percent');
  const [percent, setPercent] = useState('30');
  const [durationMonths, setDurationMonths] = useState('6');
  const [lifetime, setLifetime] = useState(false);
  const [fee, setFee] = useState('50');
  const [cookieWindowDays, setCookieWindowDays] = useState('60');
  const [bonusTrigger, setBonusTrigger] = useState('');
  const [bonusAmount, setBonusAmount] = useState('');
  const [bonusDescription, setBonusDescription] = useState('');

  const mut = useMutation({
    mutationFn: () => {
      const bonuses =
        bonusTrigger && bonusAmount
          ? [{ description: bonusDescription || `$${bonusAmount} bonus at $${bonusTrigger} MRR`, triggerRevenueUsd: Number(bonusTrigger), bonusUsd: Number(bonusAmount) }]
          : undefined;
      const payout =
        payoutType === 'recurring_percent'
          ? { type: 'recurring_percent' as const, percent: Number(percent), durationMonths: lifetime ? null : Number(durationMonths) }
          : { type: 'one_time_fee' as const, amount: Number(fee) };
      return api<{ offering: Offering }>('/network/offerings', {
        method: 'POST',
        body: {
          title,
          productUrl,
          description: description || undefined,
          vendorCampaignId,
          terms: { payout, cookieWindowDays: Number(cookieWindowDays), bonuses },
          published: true,
        },
      });
    },
    onSuccess: onCreated,
  });

  return (
    <Card style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 14 }}>New offering</div>
      <ErrorBanner error={mut.error} />
      <div style={{ marginBottom: 12 }}>
        <Label>Title</Label>
        <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Acme Pro — 30% recurring" />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 12, marginBottom: 12 }}>
        <div>
          <Label>Product URL</Label>
          <Input value={productUrl} onChange={(e) => setProductUrl(e.target.value)} placeholder="https://…" />
        </div>
        <div>
          <Label>Vendor campaign id</Label>
          <Input value={vendorCampaignId} onChange={(e) => setVendorCampaignId(e.target.value)} placeholder="01KPY…" />
        </div>
      </div>
      <div style={{ marginBottom: 12 }}>
        <Label>Description</Label>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={3}
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
          placeholder="Sell our flagship to your audience…"
        />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '140px 1fr 1fr 120px', gap: 12, marginBottom: 12, alignItems: 'end' }}>
        <div>
          <Label>Payout type</Label>
          <Select value={payoutType} onChange={(e) => setPayoutType(e.target.value as typeof payoutType)}>
            <option value="recurring_percent">Recurring %</option>
            <option value="one_time_fee">One-time $</option>
          </Select>
        </div>
        {payoutType === 'recurring_percent' ? (
          <>
            <div>
              <Label>Percent</Label>
              <Input type="number" value={percent} onChange={(e) => setPercent(e.target.value)} />
            </div>
            <div>
              <Label>Duration (months)</Label>
              <Input type="number" value={durationMonths} onChange={(e) => setDurationMonths(e.target.value)} disabled={lifetime} />
            </div>
            <label style={{ fontSize: 13, color: theme.textMuted, display: 'flex', gap: 6, alignItems: 'center', paddingBottom: 10 }}>
              <input type="checkbox" checked={lifetime} onChange={(e) => setLifetime(e.target.checked)} />
              Lifetime
            </label>
          </>
        ) : (
          <>
            <div>
              <Label>Fee ($)</Label>
              <Input type="number" value={fee} onChange={(e) => setFee(e.target.value)} />
            </div>
            <div />
            <div />
          </>
        )}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '140px 1fr 1fr 2fr', gap: 12, marginBottom: 16, alignItems: 'end' }}>
        <div>
          <Label>Cookie window (days)</Label>
          <Input type="number" value={cookieWindowDays} onChange={(e) => setCookieWindowDays(e.target.value)} />
        </div>
        <div>
          <Label>Bonus trigger ($MRR)</Label>
          <Input type="number" value={bonusTrigger} onChange={(e) => setBonusTrigger(e.target.value)} placeholder="10000" />
        </div>
        <div>
          <Label>Bonus amount ($)</Label>
          <Input type="number" value={bonusAmount} onChange={(e) => setBonusAmount(e.target.value)} placeholder="500" />
        </div>
        <div>
          <Label>Bonus description</Label>
          <Input value={bonusDescription} onChange={(e) => setBonusDescription(e.target.value)} placeholder="optional" />
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <Button onClick={() => mut.mutate()} disabled={!title || !productUrl || !vendorCampaignId || mut.isPending}>
          {mut.isPending ? 'Publishing…' : 'Publish'}
        </Button>
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </Card>
  );
}
