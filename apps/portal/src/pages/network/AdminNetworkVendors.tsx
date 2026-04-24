import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Store, Check, Copy, ShieldCheck, ShieldAlert, ShieldX, Loader2 } from 'lucide-react';
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

interface VerifyResult {
  ok: boolean;
  introspect?: { role?: string; scopes?: string[]; unrestricted?: boolean };
  recommended?: string[];
  missing?: string[];
  unrestricted?: boolean;
  acceptable?: boolean;
  error?: string;
  detail?: string;
}

function CreateVendor({ onClose, onCreated }: { onClose: () => void; onCreated: (vendorKey: string) => void }) {
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [instanceUrl, setInstanceUrl] = useState('');
  const [instanceKey, setInstanceKey] = useState('');
  const [routerUrl, setRouterUrl] = useState('');
  const [websiteUrl, setWebsiteUrl] = useState('');
  const [description, setDescription] = useState('');

  const verify = useMutation<VerifyResult, unknown, void>({
    mutationFn: () =>
      api<VerifyResult>('/network/vendors/verify-key', {
        method: 'POST',
        body: { instanceUrl, instanceKey },
      }),
  });

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
          <Label>Instance scoped API key</Label>
          <Input type="password" value={instanceKey} onChange={(e) => setInstanceKey(e.target.value)} placeholder="op_…" />
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <Button
          variant="secondary"
          size="sm"
          icon={verify.isPending ? <Loader2 size={12} /> : <ShieldCheck size={12} />}
          onClick={() => verify.mutate()}
          disabled={!instanceUrl || !instanceKey || verify.isPending}
        >
          {verify.isPending ? 'Verifying…' : 'Verify key'}
        </Button>
      </div>
      <KeyVerification result={verify.data} error={verify.error} />
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

function KeyVerification({ result, error }: { result?: VerifyResult; error: unknown }) {
  if (error) {
    const detail = error instanceof Error ? error.message : 'Could not verify the key.';
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          background: theme.dangerSoft,
          border: `1px solid ${theme.danger}55`,
          padding: '10px 12px',
          borderRadius: theme.radiusSm,
          marginBottom: 12,
          fontSize: 13,
          color: theme.danger,
        }}
      >
        <ShieldX size={16} />
        <div>{detail}</div>
      </div>
    );
  }
  if (!result) return null;

  if (result.unrestricted) {
    return (
      <div
        style={{
          background: theme.warnSoft,
          border: `1px solid ${theme.warn}55`,
          padding: '10px 12px',
          borderRadius: theme.radiusSm,
          marginBottom: 12,
          fontSize: 13,
          color: theme.warn,
          display: 'flex',
          gap: 10,
          alignItems: 'flex-start',
        }}
      >
        <ShieldAlert size={16} style={{ flexShrink: 0, marginTop: 1 }} />
        <div>
          <div style={{ fontWeight: 500, marginBottom: 4 }}>This is a full admin key</div>
          <div style={{ color: `${theme.warn}cc` }}>
            The Network would have unrestricted power over the vendor's instance. Strongly prefer a{' '}
            <strong>scoped</strong> key. On the vendor's instance run:{' '}
            <code style={{ fontSize: 12 }}>
              POST /api-keys/scoped {`{"scopes": ${JSON.stringify(result.recommended ?? [])}}`}
            </code>
          </div>
        </div>
      </div>
    );
  }

  const scopes = result.introspect?.scopes ?? [];
  const missing = result.missing ?? [];

  if (missing.length > 0) {
    return (
      <div
        style={{
          background: theme.dangerSoft,
          border: `1px solid ${theme.danger}55`,
          padding: '10px 12px',
          borderRadius: theme.radiusSm,
          marginBottom: 12,
          fontSize: 13,
          color: theme.danger,
          display: 'flex',
          gap: 10,
          alignItems: 'flex-start',
        }}
      >
        <ShieldX size={16} style={{ flexShrink: 0, marginTop: 1 }} />
        <div>
          <div style={{ fontWeight: 500, marginBottom: 4 }}>
            Missing required scopes: {missing.join(', ')}
          </div>
          <div style={{ color: `${theme.danger}cc` }}>
            Key has: {scopes.length === 0 ? <em>none</em> : scopes.map((s) => <code key={s} style={{ marginRight: 6 }}>{s}</code>)}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      style={{
        background: theme.successSoft,
        border: `1px solid ${theme.success}55`,
        padding: '10px 12px',
        borderRadius: theme.radiusSm,
        marginBottom: 12,
        fontSize: 13,
        color: theme.success,
        display: 'flex',
        gap: 10,
        alignItems: 'flex-start',
      }}
    >
      <ShieldCheck size={16} style={{ flexShrink: 0, marginTop: 1 }} />
      <div>
        <div style={{ fontWeight: 500, marginBottom: 4 }}>Scoped key looks good</div>
        <div style={{ color: `${theme.success}cc` }}>
          Scopes: {scopes.map((s) => <code key={s} style={{ marginRight: 6 }}>{s}</code>)}
        </div>
      </div>
    </div>
  );
}
