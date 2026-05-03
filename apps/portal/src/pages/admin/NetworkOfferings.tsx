import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../api.js';
import { Button, Card, ErrorBanner, Input, Label, Page, Select, Textarea } from '../../ui.js';

interface OfferingTerms {
  commissionDescription?: string;
  cookieWindowDays?: number;
  payoutCadence?: string;
  payoutHoldbackDays?: number;
  bonuses?: string[];
  // Snapshot of the bound Campaign's attribution config — surfaced on
  // the marketplace listing so creators can filter by these values.
  attributionWindowDays?: number;
  attributionModel?: string;
  commissionType?: 'percent' | 'fixed';
  commissionValue?: number;
  recurring?: boolean;
  // Snapshot of the bound Campaign's endsAt. Null = indefinite. Used
  // by the discover grid to filter / chip the program's remaining
  // runway. Re-publish the offering after a campaign extension to
  // re-snapshot.
  campaignEndsAt?: string | null;
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
  destinationUrl: string;
  deepLinkAllowedDomains: string | null;
  holdbackDays: number | null;
  attributionWindowDays: number;
  attributionModel: string;
  commissionRule: { type: 'percent' | 'fixed'; value: number; recurring?: boolean };
  endsAt: string | null;
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
        <OfferingCard
          key={o.id}
          offering={o}
          togglePublished={togglePublished}
          del={del}
        />
      ))}
    </>
  );
}

interface OfferingCardProps {
  offering: Offering;
  togglePublished: ReturnType<typeof useMutation<unknown, Error, { id: string; published: boolean }>>;
  del: ReturnType<typeof useMutation<unknown, Error, string>>;
}

function OfferingCard({ offering: o, togglePublished, del }: OfferingCardProps) {
  const [editing, setEditing] = useState(false);
  return (
    <Card>
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
        {!editing && (
          <Button onClick={() => setEditing(true)} variant="secondary">
            Edit
          </Button>
        )}
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
      {editing ? (
        <EditOfferingForm offering={o} onClose={() => setEditing(false)} />
      ) : (
        <>
          <p style={{ color: '#6b7280', fontSize: 13, margin: '4px 0' }}>
            {o.terms.commissionDescription} · campaign <code>{o.vendorCampaignId}</code>
            {o.terms.payoutHoldbackDays != null && o.terms.payoutHoldbackDays > 0 && (
              <> · pays out {o.terms.payoutHoldbackDays}d after conversion</>
            )}
          </p>
          {o.description && <p>{o.description}</p>}
          <p style={{ fontSize: 13 }}>
            <a href={o.productUrl} target="_blank" rel="noopener noreferrer">{o.productUrl} ↗</a>
          </p>
        </>
      )}
    </Card>
  );
}

/**
 * Inline edit form for an existing offering. Two tiers:
 *
 *   - Free-text fields (title, description) — edit freely. These don't
 *     change anything a creator has been quoted, just the listing copy.
 *
 *   - Contract fields (commissionDescription, cookieWindowDays) — edit
 *     allowed but with a warning. These are visible to creators when
 *     they apply; changing them after partnerships exist is a
 *     unilateral change to the deal. Useful for fixing typos or
 *     clarifying language; not great for materially shifting terms.
 *
 *   - Snapshotted-from-Campaign fields (commission %, holdback,
 *     attribution model/window, destination URL) are deliberately NOT
 *     editable here — they live on the Campaign as the source of
 *     truth. Editing them here would silently diverge the Network
 *     listing from what the brand actually pays / where their links
 *     send. Surfaced as read-only with a "edit the campaign instead"
 *     hint so the admin doesn't have to guess where to go.
 */
function EditOfferingForm({ offering, onClose }: { offering: Offering; onClose: () => void }) {
  const qc = useQueryClient();
  const [title, setTitle] = useState(offering.title);
  const [description, setDescription] = useState(offering.description ?? '');
  const [commissionDescription, setCommissionDescription] = useState(
    offering.terms.commissionDescription ?? '',
  );
  const [cookieWindowDays, setCookieWindowDays] = useState<number | ''>(
    offering.terms.cookieWindowDays ?? '',
  );
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () =>
      api(`/admin/network/offerings/${offering.id}`, {
        method: 'PATCH',
        body: {
          title: title.trim(),
          description: description.trim() === '' ? null : description.trim(),
          // Merge into the existing terms snapshot so we don't drop
          // the Campaign-derived fields (commissionType/Value,
          // attributionModel, payoutHoldbackDays, campaignEndsAt, ...).
          terms: {
            ...offering.terms,
            commissionDescription: commissionDescription.trim(),
            cookieWindowDays: cookieWindowDays === '' ? undefined : Number(cookieWindowDays),
          },
        },
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['network-offerings'] });
      onClose();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'failed'),
  });

  const dirty =
    title !== offering.title ||
    description !== (offering.description ?? '') ||
    commissionDescription !== (offering.terms.commissionDescription ?? '') ||
    String(cookieWindowDays) !== String(offering.terms.cookieWindowDays ?? '');

  return (
    <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid #e5e7eb' }}>
      {error && <ErrorBanner error={error} />}
      <div style={{ marginBottom: 12 }}>
        <Label>Title</Label>
        <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} />
      </div>
      <div style={{ marginBottom: 12 }}>
        <Label>Description</Label>
        <Textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={3}
          placeholder="What you sell, who it's for, why it converts."
        />
      </div>
      <div
        style={{
          marginBottom: 12,
          padding: 10,
          background: '#fff8e6',
          border: '1px solid #f5d782',
          borderRadius: 6,
          fontSize: 12,
          color: '#7a5400',
        }}
      >
        ⚠️ The fields below are shown to creators when they apply.
        Editing them after creators have partnered is effectively a
        unilateral change to your deal. Fine for typos or clarification;
        avoid for material shifts in commission or attribution.
      </div>
      <div style={{ marginBottom: 12 }}>
        <Label>Commission summary (shown to creators)</Label>
        <Input
          value={commissionDescription}
          onChange={(e) => setCommissionDescription(e.target.value)}
          maxLength={200}
          placeholder="20% recurring on all plans"
        />
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
      <div
        style={{
          marginBottom: 14,
          padding: 10,
          background: '#f3f4f6',
          border: '1px solid #d1d5db',
          borderRadius: 6,
          fontSize: 12,
          color: '#4b5563',
        }}
      >
        Commission %, holdback, attribution model/window, and the
        destination URL come from the bound Campaign (
        <code>{offering.vendorCampaignId}</code>). Edit the Campaign in
        Admin → Campaigns to change those, then re-publish this
        offering to refresh the snapshot.
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <Button onClick={() => save.mutate()} disabled={save.isPending || !dirty || !title.trim() || !commissionDescription.trim()}>
          {save.isPending ? 'Saving…' : 'Save changes'}
        </Button>
        <Button onClick={onClose} variant="secondary" disabled={save.isPending}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function CreateOfferingForm() {
  const qc = useQueryClient();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [vendorCampaignId, setVendorCampaignId] = useState('');
  const [commissionDescription, setCommissionDescription] = useState('');
  const [cookieWindowDays, setCookieWindowDays] = useState<number | ''>('');
  const [error, setError] = useState<string | null>(null);

  // Pull campaigns so the admin can pick from a dropdown. Each campaign
  // carries its destinationUrl + deep-link allowlist; the picked
  // campaign's destination becomes the offering's productUrl on create.
  // We don't expose a separate URL input — same source of truth as
  // brand-side Links so creators land where the brand intended.
  const { data: campaigns } = useQuery({
    queryKey: ['campaigns'],
    queryFn: () => api<{ campaigns: Campaign[] }>('/campaigns'),
  });

  const selectedCampaign = campaigns?.campaigns.find((c) => c.id === vendorCampaignId);

  const m = useMutation({
    mutationFn: () => {
      if (!selectedCampaign) throw new Error('campaign_required');
      return api('/admin/network/offerings', {
        method: 'POST',
        body: {
          title,
          description: description || undefined,
          // Inherit destination from the bound Campaign — single source
          // of truth on the brand side. Network stores a snapshot for
          // marketplace display.
          productUrl: selectedCampaign.destinationUrl,
          vendorCampaignId,
          terms: {
            commissionDescription,
            cookieWindowDays: cookieWindowDays === '' ? undefined : Number(cookieWindowDays),
            // Snapshot the bound Campaign's attribution + commission
            // config so creators can filter the discover grid by them.
            // Single source of truth — the brand sets these on the
            // Campaign once, every Offering reflects them. Re-publish
            // an offering to re-snapshot after a campaign edit.
            payoutHoldbackDays: selectedCampaign.holdbackDays ?? undefined,
            attributionWindowDays: selectedCampaign.attributionWindowDays,
            attributionModel: selectedCampaign.attributionModel,
            commissionType: selectedCampaign.commissionRule.type,
            commissionValue: selectedCampaign.commissionRule.value,
            recurring: selectedCampaign.commissionRule.recurring ?? false,
            // Snapshot of the campaign's end date. Null = indefinite —
            // creators see "Ongoing" on the discover card. Re-publish
            // after a campaign extension to refresh.
            campaignEndsAt: selectedCampaign.endsAt ?? null,
          },
          published: true,
        },
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['network-offerings'] });
      setTitle(''); setDescription(''); setVendorCampaignId('');
      setCommissionDescription(''); setCookieWindowDays('');
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'failed'),
  });

  useEffect(() => { setError(null); }, [title, vendorCampaignId, commissionDescription]);

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
        <Textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={3}
          placeholder="What you sell, who it's for, why it converts."
        />
      </div>
      <div style={{ marginBottom: 12 }}>
        <Label>Campaign (commission rule + destination URL live here)</Label>
        <Select value={vendorCampaignId} onChange={(e) => setVendorCampaignId(e.target.value)}>
          <option value="">— pick a campaign —</option>
          {campaigns?.campaigns.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </Select>
        {selectedCampaign && (
          <div style={{ fontSize: 12, color: '#6b7280', marginTop: 6 }}>
            Creators will land on{' '}
            <a href={selectedCampaign.destinationUrl} target="_blank" rel="noopener noreferrer">
              {selectedCampaign.destinationUrl}
            </a>
            {selectedCampaign.deepLinkAllowedDomains && ' (deep links allowed)'}
          </div>
        )}
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
        disabled={m.isPending || !title || !selectedCampaign || !commissionDescription}
      >
        {m.isPending ? 'Publishing…' : 'Publish offering'}
      </Button>
    </Card>
  );
}
