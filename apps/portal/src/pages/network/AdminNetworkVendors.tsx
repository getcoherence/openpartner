import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Store, Check, Copy } from 'lucide-react';
import { api } from '../../api.js';
import { theme } from '../../theme.js';
import { Avatar, Button, Card, EmptyState, ErrorBanner, Input, Label, Page, StatusPill, Table, formatDate } from '../../ui.js';

interface Vendor {
  id: string;
  name: string;
  slug: string;
  instanceUrl: string;
  instanceKeyPrefix: string;
  routerUrl: string | null;
  status: string;
  createdAt: string;
  activatedAt: string | null;
}

export function AdminNetworkVendors() {
  const qc = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);
  const [newlyIssuedKey, setNewlyIssuedKey] = useState<string | null>(null);

  const vendors = useQuery({
    queryKey: ['network-vendors'],
    queryFn: () => api<{ vendors: Vendor[] }>('/network/vendors'),
  });

  const activate = useMutation({
    mutationFn: (id: string) => api(`/network/vendors/${id}/activate`, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['network-vendors'] }),
  });

  return (
    <Page
      title="Network vendors"
      subtitle="Merchants registered on the OpenPartner Network."
      actions={
        <Button icon={<Plus size={14} />} onClick={() => setShowCreate(true)}>
          Onboard vendor
        </Button>
      }
    >
      <ErrorBanner error={vendors.error ?? activate.error} />

      {newlyIssuedKey && (
        <Card style={{ marginBottom: 14, borderColor: `${theme.warn}55` }}>
          <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 6 }}>Vendor key issued</div>
          <div style={{ color: theme.textMuted, fontSize: 13, marginBottom: 10 }}>
            Share this key with the vendor. It won't be shown again.
          </div>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              background: theme.warnSoft,
              border: `1px solid ${theme.warn}33`,
              padding: '10px 12px',
              borderRadius: theme.radiusSm,
            }}
          >
            <code style={{ flex: 1, fontSize: 12, wordBreak: 'break-all' }}>{newlyIssuedKey}</code>
            <Button size="sm" variant="secondary" icon={<Copy size={12} />} onClick={() => navigator.clipboard.writeText(newlyIssuedKey)}>
              Copy
            </Button>
          </div>
          <Button size="sm" variant="ghost" style={{ marginTop: 10 }} onClick={() => setNewlyIssuedKey(null)}>
            Dismiss
          </Button>
        </Card>
      )}

      {showCreate && (
        <CreateVendor
          onClose={() => setShowCreate(false)}
          onCreated={(key) => {
            setShowCreate(false);
            setNewlyIssuedKey(key);
            qc.invalidateQueries({ queryKey: ['network-vendors'] });
          }}
        />
      )}
      {vendors.isLoading ? (
        <Card>Loading…</Card>
      ) : (vendors.data?.vendors ?? []).length === 0 ? (
        <EmptyState title="No vendors yet" hint="Onboard a vendor to populate the directory." icon={<Store size={28} strokeWidth={1.25} />} />
      ) : (
        <Table
          columns={['Vendor', 'Instance', 'Router', 'Status', 'Actions']}
          rows={(vendors.data?.vendors ?? []).map((v) => [
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <Avatar name={v.name} size={28} />
              <div>
                <div style={{ fontWeight: 500 }}>{v.name}</div>
                <div style={{ fontSize: 12, color: theme.textMuted }}>{v.slug}</div>
              </div>
            </div>,
            <code style={{ color: theme.textMuted, fontSize: 12 }}>{v.instanceUrl}</code>,
            v.routerUrl ? (
              <code style={{ color: theme.accent, fontSize: 12 }}>{v.routerUrl}</code>
            ) : (
              <span style={{ color: theme.textDim, fontSize: 12 }}>(inferred)</span>
            ),
            <StatusPill status={v.status === 'active' ? 'connected' : v.status} />,
            v.status !== 'active' ? (
              <Button size="sm" onClick={() => activate.mutate(v.id)} icon={<Check size={12} />}>
                Activate
              </Button>
            ) : (
              <span style={{ color: theme.textMuted, fontSize: 12 }}>
                activated {formatDate(v.activatedAt, { relative: true })}
              </span>
            ),
          ])}
        />
      )}
    </Page>
  );
}

function CreateVendor({ onClose, onCreated }: { onClose: () => void; onCreated: (vendorKey: string) => void }) {
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [instanceUrl, setInstanceUrl] = useState('');
  const [instanceKey, setInstanceKey] = useState('');
  const [routerUrl, setRouterUrl] = useState('');
  const [websiteUrl, setWebsiteUrl] = useState('');
  const [description, setDescription] = useState('');

  const mut = useMutation({
    mutationFn: () =>
      api<{ vendor: Vendor; apiKey: string }>('/network/vendors', {
        method: 'POST',
        body: {
          name,
          slug,
          instanceUrl,
          instanceKey,
          routerUrl: routerUrl || undefined,
          websiteUrl: websiteUrl || undefined,
          description: description || undefined,
        },
      }),
    onSuccess: (data) => onCreated(data.apiKey),
  });

  return (
    <Card style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 14 }}>Onboard vendor</div>
      <ErrorBanner error={mut.error} />
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
        <div>
          <Label>Name</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme" />
        </div>
        <div>
          <Label>Slug</Label>
          <Input value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="acme" />
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
        <div>
          <Label>OpenPartner instance URL</Label>
          <Input value={instanceUrl} onChange={(e) => setInstanceUrl(e.target.value)} placeholder="https://acme.example.com/api" />
        </div>
        <div>
          <Label>Instance admin API key</Label>
          <Input type="password" value={instanceKey} onChange={(e) => setInstanceKey(e.target.value)} placeholder="op_…" />
        </div>
      </div>
      <div style={{ marginBottom: 12 }}>
        <Label>Router URL (where share links resolve)</Label>
        <Input value={routerUrl} onChange={(e) => setRouterUrl(e.target.value)} placeholder="https://getcoherence.io" />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 12, marginBottom: 14 }}>
        <div>
          <Label>Website (optional)</Label>
          <Input value={websiteUrl} onChange={(e) => setWebsiteUrl(e.target.value)} placeholder="https://acme.example" />
        </div>
        <div>
          <Label>Description</Label>
          <Input value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <Button onClick={() => mut.mutate()} disabled={!name || !slug || !instanceUrl || !instanceKey || mut.isPending}>
          {mut.isPending ? 'Registering…' : 'Register'}
        </Button>
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </Card>
  );
}
