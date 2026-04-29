import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../api.js';
import { Button, Card, ErrorBanner, Input, Label, Page, Select } from '../../ui.js';
import { theme } from '../../theme.js';

interface OfferingTerms {
  commissionDescription?: string;
  cookieWindowDays?: number;
  payoutCadence?: string;
  bonuses?: string[];
}

interface Offering {
  id: string;
  vendorId: string;
  title: string;
  description: string | null;
  productUrl: string;
  heroImageUrl: string | null;
  vendorCampaignId: string;
  terms: OfferingTerms;
  published: boolean;
  createdAt: string;
  updatedAt: string;
}

interface Campaign {
  id: string;
  name: string;
}

export function AdminNetworkOfferings() {
  return (
    <Page
      title="Network offerings"
      subtitle="Programs you publish on the OpenPartner Network for creators to discover."
    >
      <CreateOfferingForm />
      <div style={{ height: 18 }} />
      <OfferingList />
    </Page>
  );
}

function OfferingList() {
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ['network-offerings'],
    queryFn: () => api<{ offerings: Offering[] }>('/admin/network/offerings'),
    retry: false,
  });
  const del = useMutation({
    mutationFn: (id: string) => api(`/admin/network/offerings/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['network-offerings'] }),
  });
  const togglePublished = useMutation({
    mutationFn: ({ id, published }: { id: string; published: boolean }) =>
      api(`/admin/network/offerings/${id}`, { method: 'PATCH', body: { published } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['network-offerings'] }),
  });

  if (error) {
    const msg = error instanceof ApiError && error.message.includes('network_not_configured')
      ? 'Connect to the Network first under Settings → Network.'
      : `Couldn't load offerings: ${error instanceof Error ? error.message : String(error)}`;
    return <ErrorBanner error={msg} />;
  }
  if (isLoading) return <Card><p>Loading…</p></Card>;
  const offerings = data?.offerings ?? [];
  if (offerings.length === 0) {
    return <Card><p style={{ color: '#6b7280' }}>No offerings yet. Create one above.</p></Card>;
  }
  return (
    <>
      {offerings.map((o) => (
        <Card key={o.id}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
            <h3 style={{ marginTop: 0, marginBottom: 4, flex: 1 }}>
              {o.title}{' '}
              <span style={{
                fontSize: 11,
                padding: '2px 8px',
                borderRadius: 12,
                background: o.published ? '#d4f0d4' : '#fff7d4',
                color: o.published ? '#1a6b1a' : '#8b6f00',
              }}>
                {o.published ? 'published' : 'draft'}
              </span>
            </h3>
            <Button
              onClick={() => togglePublished.mutate({ id: o.id, published: !o.published })}
              disabled={togglePublished.isPending}
              variant="secondary"
            >
              {o.published ? 'Unpublish' : 'Publish'}
            </Button>
            <Button
              onClick={() => {
                if (confirm(`Delete "${o.title}"?`)) del.mutate(o.id);
              }}
              disabled={del.isPending}
              variant="danger"
            >
              Delete
            </Button>
          </div>
          <p style={{ color: '#6b7280', fontSize: 13, margin: '4px 0' }}>
            {o.terms.commissionDescription} · campaign <code>{o.vendorCampaignId}</code>
          </p>
          {o.description && <p>{o.description}</p>}
          <p style={{ fontSize: 13 }}>
            <a href={o.productUrl} target="_blank" rel="noopener noreferrer">{o.productUrl} ↗</a>
          </p>
        </Card>
      ))}
    </>
  );
}

function CreateOfferingForm() {
  const qc = useQueryClient();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [productUrl, setProductUrl] = useState('');
  const [vendorCampaignId, setVendorCampaignId] = useState('');
  const [commissionDescription, setCommissionDescription] = useState('');
  const [cookieWindowDays, setCookieWindowDays] = useState<number | ''>('');
  const [error, setError] = useState<string | null>(null);

  // Pull campaigns so the admin can pick from a dropdown.
  const { data: campaigns } = useQuery({
    queryKey: ['campaigns'],
    queryFn: () => api<{ campaigns: Campaign[] }>('/campaigns'),
  });

  const m = useMutation({
    mutationFn: () => api('/admin/network/offerings', {
      method: 'POST',
      body: {
        title,
        description: description || undefined,
        productUrl,
        vendorCampaignId,
        terms: {
          commissionDescription,
          cookieWindowDays: cookieWindowDays === '' ? undefined : Number(cookieWindowDays),
        },
        published: true,
      },
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['network-offerings'] });
      setTitle(''); setDescription(''); setProductUrl(''); setVendorCampaignId('');
      setCommissionDescription(''); setCookieWindowDays('');
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'failed'),
  });

  useEffect(() => { setError(null); }, [title, productUrl, vendorCampaignId, commissionDescription]);

  return (
    <Card>
      <h3 style={{ marginTop: 0 }}>Publish a new offering</h3>
      {error && <ErrorBanner error={error} />}
      <div style={{ marginBottom: 12 }}>
        <Label>Title</Label>
        <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Acme Pro — 20% recurring" />
      </div>
      <div style={{ marginBottom: 12 }}>
        <Label>Description (markdown OK on the Network side)</Label>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={3}
          placeholder="What you sell, who it's for, why it converts."
          style={{
            width: '100%',
            padding: '10px 12px',
            background: theme.surface2,
            border: `1px solid ${theme.border}`,
            borderRadius: theme.radiusSm,
            color: theme.text,
            fontSize: 14,
            fontFamily: 'inherit',
            resize: 'vertical',
          }}
        />
      </div>
      <div style={{ marginBottom: 12 }}>
        <Label>Product URL (where the share link redirects to)</Label>
        <Input value={productUrl} onChange={(e) => setProductUrl(e.target.value)} placeholder="https://acme.example.com/pro" />
      </div>
      <div style={{ marginBottom: 12 }}>
        <Label>Campaign (commission rule lives here)</Label>
        <Select value={vendorCampaignId} onChange={(e) => setVendorCampaignId(e.target.value)}>
          <option value="">— pick a campaign —</option>
          {campaigns?.campaigns.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </Select>
      </div>
      <div style={{ marginBottom: 12 }}>
        <Label>Commission summary (shown to creators)</Label>
        <Input value={commissionDescription} onChange={(e) => setCommissionDescription(e.target.value)} placeholder="20% recurring on all plans" />
      </div>
      <div style={{ marginBottom: 12 }}>
        <Label>Cookie window (days, optional)</Label>
        <Input
          type="number"
          value={cookieWindowDays}
          onChange={(e) => setCookieWindowDays(e.target.value === '' ? '' : Number(e.target.value))}
          placeholder="60"
        />
      </div>
      <Button
        onClick={() => m.mutate()}
        disabled={m.isPending || !title || !productUrl || !vendorCampaignId || !commissionDescription}
      >
        {m.isPending ? 'Publishing…' : 'Publish offering'}
      </Button>
    </Card>
  );
}
