import { useEffect, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Settings as SettingsIcon, Mail, Wallet, Palette, Image as ImageIcon, Trash2 } from 'lucide-react';
import { api } from '../../api.js';
import { theme } from '../../theme.js';
import { Button, Card, ErrorBanner, Input, Label, Page, Select } from '../../ui.js';

type PayoutRail = 'auto' | 'stripe_connect' | 'manual';
type PayoutCadence = 'weekly' | 'biweekly' | 'monthly' | 'manual';

interface PayoutSettings {
  rail: PayoutRail;
  thresholdCents: number;
  cadence: PayoutCadence;
}

interface ProgramSettings {
  programName: string | null;
  supportEmail: string | null;
  logoUrl: string | null;
  brandColor: string | null;
  programTermsUrl: string | null;
  whiteLabel: boolean;
}

type BrandAssetKind = 'image' | 'snippet';

interface BrandAsset {
  id: string;
  kind: BrandAssetKind | 'document';
  label: string;
  description: string | null;
  url: string | null;
  body: string | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

type MailKind = 'smtp' | 'postmark' | 'none';

interface PublicMailSettings {
  kind: MailKind | null;
  from: string | null;
  smtp: { host: string; port: number; secure: boolean; user: string | null; hasPassword: boolean } | null;
  postmark: { hasToken: boolean; messageStream: string } | null;
}

export function AdminSettings() {
  return (
    <Page title="Settings" subtitle="How the partner portal identifies your brand, sends mail, and pays partners.">
      <ProgramSection />
      <div style={{ height: 18 }} />
      <BrandResourcesSection />
      <div style={{ height: 18 }} />
      <PayoutSection />
      <div style={{ height: 18 }} />
      <MailSection />
      <div style={{ height: 18 }} />
      <DangerZone />
    </Page>
  );
}

// ---------- program ----------

function ProgramSection() {
  const qc = useQueryClient();
  const { data, error, isLoading } = useQuery({
    queryKey: ['program-settings'],
    queryFn: () => api<ProgramSettings>('/config/program'),
  });

  const [programName, setProgramName] = useState('');
  const [supportEmail, setSupportEmail] = useState('');
  const [brandColor, setBrandColor] = useState('');
  const [programTermsUrl, setProgramTermsUrl] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!data) return;
    setProgramName(data.programName ?? '');
    setSupportEmail(data.supportEmail ?? '');
    setBrandColor(data.brandColor ?? '');
    setProgramTermsUrl(data.programTermsUrl ?? '');
  }, [data]);

  const mut = useMutation({
    mutationFn: () =>
      api<ProgramSettings>('/config/program', {
        method: 'POST',
        body: { programName, supportEmail, brandColor, programTermsUrl },
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['program-settings'] });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    },
  });

  if (isLoading) return <Card>Loading…</Card>;

  return (
    <Card>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
        <SettingsIcon size={18} color={theme.accent} />
        <div style={{ fontSize: 15, fontWeight: 500 }}>Brand info</div>
      </div>
      <ErrorBanner error={error ?? mut.error} />
      <LogoUploader logoUrl={data?.logoUrl ?? null} brandName={data?.programName ?? null} />
      <div style={{ marginBottom: 16 }}>
        <Label>Brand name</Label>
        <Input value={programName} onChange={(e) => setProgramName(e.target.value)} placeholder="e.g. Acme" maxLength={120} />
        <Hint>
          Shown to partners in the portal.
          {data?.whiteLabel ? ' Leave blank to fall back to your workspace name.' : ' Leave blank to fall back to "OpenPartner".'}
        </Hint>
      </div>
      <div style={{ marginBottom: 16 }}>
        <Label>Support email</Label>
        <Input
          type="email"
          value={supportEmail}
          onChange={(e) => setSupportEmail(e.target.value)}
          placeholder="support@yourdomain.com"
          maxLength={254}
        />
        <Hint>Partners see this in their portal footer.</Hint>
      </div>
      <div className="op-grid-collapse" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 16 }}>
        <div>
          <Label>Brand color</Label>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input
              type="color"
              value={brandColor || '#16a34a'}
              onChange={(e) => setBrandColor(e.target.value)}
              style={{
                width: 38,
                height: 38,
                padding: 0,
                border: `1px solid ${theme.borderSubtle}`,
                borderRadius: theme.radiusSm,
                background: 'transparent',
                cursor: 'pointer',
              }}
            />
            <Input
              value={brandColor}
              onChange={(e) => setBrandColor(e.target.value)}
              placeholder="#16a34a"
              maxLength={9}
              style={{ fontFamily: theme.fontMono }}
            />
          </div>
          <Hint>Hex code. {data?.whiteLabel ? 'Blank uses the default green.' : "Blank = OpenPartner's default green."}</Hint>
        </div>
        <div>
          <Label>Program terms URL</Label>
          <Input
            type="url"
            value={programTermsUrl}
            onChange={(e) => setProgramTermsUrl(e.target.value)}
            placeholder="https://yourdomain.com/partner-terms"
            maxLength={2048}
          />
          <Hint>Linked from the partner portal footer. Blank = no terms link shown.</Hint>
        </div>
      </div>
      <Row>
        <Button onClick={() => mut.mutate()} disabled={mut.isPending}>
          {mut.isPending ? 'Saving…' : 'Save program info'}
        </Button>
        {saved && <span style={{ color: theme.success, fontSize: 13 }}>Saved.</span>}
      </Row>
    </Card>
  );
}

// ---------- brand resources (assets library) ----------

function BrandResourcesSection() {
  const qc = useQueryClient();
  const { data, error, isLoading } = useQuery({
    queryKey: ['brand-resources'],
    queryFn: () =>
      api<{
        brand: {
          displayName: string | null;
          logoUrl: string | null;
          brandColor: string | null;
          programTermsUrl: string | null;
          supportEmail: string | null;
        };
        assets: BrandAsset[];
      }>('/brand-resources'),
  });

  if (isLoading) return <Card>Loading…</Card>;

  const assets = data?.assets ?? [];

  return (
    <Card>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
        <Palette size={18} color={theme.accent} />
        <div style={{ fontSize: 15, fontWeight: 500 }}>Brand resources</div>
      </div>
      <ErrorBanner error={error} />
      <Hint>
        Logos, hero images, and copy snippets partners can pull into their content.
        Visible to every active partner in the portal under Resources.
      </Hint>

      <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
        {assets.length === 0 ? (
          <div style={{ fontSize: 13, color: theme.textMuted, padding: '14px 0' }}>
            No resources yet. Upload an image or add a copy snippet below.
          </div>
        ) : (
          assets.map((a) => (
            <AssetRow
              key={a.id}
              asset={a}
              onChange={() => qc.invalidateQueries({ queryKey: ['brand-resources'] })}
            />
          ))
        )}
      </div>

      <div style={{ marginTop: 16, borderTop: `1px solid ${theme.borderSubtle}`, paddingTop: 16 }}>
        <AddImageForm onAdded={() => qc.invalidateQueries({ queryKey: ['brand-resources'] })} />
      </div>
      <div style={{ marginTop: 12 }}>
        <AddSnippetForm onAdded={() => qc.invalidateQueries({ queryKey: ['brand-resources'] })} />
      </div>
    </Card>
  );
}

function AssetRow({ asset, onChange }: { asset: BrandAsset; onChange: () => void }) {
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(asset.label);
  const [description, setDescription] = useState(asset.description ?? '');
  const [body, setBody] = useState(asset.body ?? '');

  const save = useMutation({
    mutationFn: () =>
      api(`/brand-resources/${asset.id}`, {
        method: 'PATCH',
        body: {
          label,
          description,
          ...(asset.kind === 'snippet' ? { body } : {}),
        },
      }),
    onSuccess: () => {
      setEditing(false);
      onChange();
    },
  });

  const del = useMutation({
    mutationFn: () => api(`/brand-resources/${asset.id}`, { method: 'DELETE' }),
    onSuccess: onChange,
  });

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        padding: 12,
        background: theme.surface2,
        border: `1px solid ${theme.borderSubtle}`,
        borderRadius: theme.radiusSm,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        {asset.kind === 'image' && asset.url ? (
          <img
            src={asset.url}
            alt={asset.label}
            style={{
              width: 48,
              height: 48,
              objectFit: 'contain',
              borderRadius: 4,
              background: theme.bg,
              flexShrink: 0,
            }}
          />
        ) : (
          <div
            style={{
              width: 48,
              height: 48,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: 4,
              background: theme.bg,
              color: theme.textMuted,
              flexShrink: 0,
            }}
          >
            <ImageIcon size={18} />
          </div>
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 500 }}>{asset.label}</div>
          <div style={{ fontSize: 11, color: theme.textMuted, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
            {asset.kind}
          </div>
        </div>
        <button
          onClick={() => setEditing((v) => !v)}
          style={{
            background: 'transparent',
            border: 'none',
            color: theme.accent,
            cursor: 'pointer',
            fontSize: 12,
            padding: 0,
          }}
        >
          {editing ? 'Cancel' : 'Edit'}
        </button>
        <button
          onClick={() => {
            if (window.confirm(`Delete "${asset.label}"?`)) del.mutate();
          }}
          style={{
            display: 'flex',
            alignItems: 'center',
            background: 'transparent',
            border: 'none',
            color: theme.danger,
            cursor: 'pointer',
            fontSize: 12,
            padding: 0,
          }}
        >
          <Trash2 size={14} />
        </button>
      </div>
      {!editing && asset.kind === 'snippet' && asset.body && (
        <div style={{ fontSize: 12, color: theme.textMuted, whiteSpace: 'pre-wrap' }}>{asset.body}</div>
      )}
      {!editing && asset.description && (
        <div style={{ fontSize: 11, color: theme.textDim }}>{asset.description}</div>
      )}
      {editing && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Label" maxLength={200} />
          <Input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Description (optional)"
            maxLength={1000}
          />
          {asset.kind === 'snippet' && (
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              maxLength={4000}
              rows={3}
              style={{
                fontFamily: theme.fontMono,
                fontSize: 13,
                padding: 10,
                background: theme.bg,
                color: theme.text,
                border: `1px solid ${theme.borderSubtle}`,
                borderRadius: theme.radiusSm,
                resize: 'vertical',
              }}
            />
          )}
          <ErrorBanner error={save.error} />
          <Row>
            <Button onClick={() => save.mutate()} disabled={save.isPending || !label.trim()}>
              {save.isPending ? 'Saving…' : 'Save'}
            </Button>
          </Row>
        </div>
      )}
    </div>
  );
}

function AddImageForm({ onAdded }: { onAdded: () => void }) {
  const [label, setLabel] = useState('');
  const [description, setDescription] = useState('');
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onPick(e: React.ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (!label.trim()) {
      setError('Add a label first so partners know what the image is for.');
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      setError('Image too large — max 2 MB.');
      return;
    }
    setError(null);
    setUploading(true);
    try {
      const upload = await api<{ url: string }>('/uploads/brand-asset', { method: 'POST', body: file });
      await api('/brand-resources/images', {
        method: 'POST',
        body: { label: label.trim(), description: description.trim() || undefined, url: upload.url },
      });
      setLabel('');
      setDescription('');
      onAdded();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <Label>Add image</Label>
      <div style={{ display: 'flex', gap: 8 }}>
        <Input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Label (e.g. Hero banner 1200x630)"
          maxLength={200}
          style={{ flex: 1 }}
        />
        <Input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Description (optional)"
          maxLength={1000}
          style={{ flex: 1 }}
        />
        <label style={{ display: 'inline-block' }}>
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp"
            onChange={onPick}
            style={{ display: 'none' }}
            disabled={uploading}
          />
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              padding: '8px 14px',
              background: theme.accent,
              color: theme.accentInk,
              borderRadius: theme.radiusSm,
              fontSize: 13,
              fontWeight: 500,
              cursor: uploading ? 'wait' : 'pointer',
              opacity: uploading ? 0.6 : 1,
              whiteSpace: 'nowrap',
            }}
          >
            {uploading ? 'Uploading…' : 'Upload'}
          </span>
        </label>
      </div>
      {error && <div style={{ fontSize: 12, color: theme.danger }}>{error}</div>}
      <Hint>PNG, JPEG, or WebP. Max 2 MB.</Hint>
    </div>
  );
}

function AddSnippetForm({ onAdded }: { onAdded: () => void }) {
  const [label, setLabel] = useState('');
  const [body, setBody] = useState('');

  const mut = useMutation({
    mutationFn: () =>
      api('/brand-resources/snippets', {
        method: 'POST',
        body: { label: label.trim(), body: body.trim() },
      }),
    onSuccess: () => {
      setLabel('');
      setBody('');
      onAdded();
    },
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <Label>Add copy snippet</Label>
      <Input
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        placeholder="Label (e.g. One-liner tagline)"
        maxLength={200}
      />
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="The snippet text partners can copy verbatim"
        rows={3}
        maxLength={4000}
        style={{
          fontFamily: theme.fontMono,
          fontSize: 13,
          padding: 10,
          background: theme.bg,
          color: theme.text,
          border: `1px solid ${theme.borderSubtle}`,
          borderRadius: theme.radiusSm,
          resize: 'vertical',
        }}
      />
      <ErrorBanner error={mut.error} />
      <Row>
        <Button onClick={() => mut.mutate()} disabled={mut.isPending || !label.trim() || !body.trim()}>
          {mut.isPending ? 'Adding…' : 'Add snippet'}
        </Button>
      </Row>
    </div>
  );
}

// ---------- payouts ----------

function PayoutSection() {
  const qc = useQueryClient();
  const { data, error, isLoading } = useQuery({
    queryKey: ['payout-settings'],
    queryFn: () => api<PayoutSettings>('/config/payouts'),
  });

  const [rail, setRail] = useState<PayoutRail>('auto');
  // Stored as cents on the server; rendered as dollars in the UI.
  const [thresholdDollars, setThresholdDollars] = useState('0');
  const [cadence, setCadence] = useState<PayoutCadence>('weekly');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!data) return;
    setRail(data.rail);
    setThresholdDollars(String(Math.round(data.thresholdCents) / 100));
    setCadence(data.cadence);
  }, [data]);

  const mut = useMutation({
    mutationFn: () => {
      const parsed = Number(thresholdDollars);
      const cents = Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed * 100) : 0;
      return api<PayoutSettings>('/config/payouts', {
        method: 'POST',
        body: { rail, thresholdCents: cents, cadence },
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['payout-settings'] });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    },
  });

  if (isLoading) return <Card>Loading…</Card>;

  return (
    <Card>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
        <Wallet size={18} color={theme.accent} />
        <div style={{ fontSize: 15, fontWeight: 500 }}>Payouts</div>
      </div>
      <ErrorBanner error={error ?? mut.error} />
      <Hint>
        How partner balances turn into transfers. Affects every program. Per-program
        holdback (refund window) is set on each program.
      </Hint>

      <div style={{ marginTop: 16, marginBottom: 16 }}>
        <Label>Payout rail</Label>
        <Select value={rail} onChange={(e) => setRail(e.target.value as PayoutRail)}>
          <option value="auto">Auto — Stripe Connect if partner has one, else manual</option>
          <option value="stripe_connect">Stripe Connect only — require connected account</option>
          <option value="manual">Manual only — operator transfers off-platform</option>
        </Select>
        <Hint>
          Auto is the default. Forcing Stripe Connect surfaces unconnected partners as
          failed payouts with a "complete onboarding" message — useful when you want
          every partner to self-serve their payouts.
        </Hint>
      </div>

      <div style={{ marginBottom: 16 }}>
        <Label>Minimum payout (USD)</Label>
        <Input
          type="number"
          min="0"
          max="1000"
          step="1"
          value={thresholdDollars}
          onChange={(e) => setThresholdDollars(e.target.value)}
          style={{ maxWidth: 160 }}
        />
        <Hint>
          Balances below this stay in "approved" status and roll into the next payout
          run. 0 = no minimum. Common values: $25, $50, $100. Anything above $1000 is
          probably a misconfiguration and won't save.
        </Hint>
      </div>

      <div style={{ marginBottom: 18 }}>
        <Label>Payout cadence</Label>
        <Select value={cadence} onChange={(e) => setCadence(e.target.value as PayoutCadence)}>
          <option value="weekly">Weekly — every Monday 09:00 UTC</option>
          <option value="biweekly">Biweekly — every other Monday (even ISO weeks)</option>
          <option value="monthly">Monthly — first Monday of the month</option>
          <option value="manual">Manual — never automatic, you trigger from the Payouts page</option>
        </Select>
        <Hint>
          Weekly is the default. Manual is for brands that audit every run before paying;
          set to manual and trigger from the Payouts page when you're ready.
        </Hint>
      </div>

      <Row>
        <Button onClick={() => mut.mutate()} disabled={mut.isPending}>
          {mut.isPending ? 'Saving…' : 'Save payout settings'}
        </Button>
        {saved && <span style={{ color: theme.success, fontSize: 13 }}>Saved.</span>}
      </Row>
    </Card>
  );
}

// ---------- mail ----------

function MailSection() {
  const qc = useQueryClient();
  const { data, error, isLoading } = useQuery({
    queryKey: ['mail-settings'],
    queryFn: () => api<PublicMailSettings>('/config/mail'),
  });

  const [kind, setKind] = useState<MailKind>('smtp');
  const [from, setFrom] = useState('');
  const [smtpHost, setSmtpHost] = useState('');
  const [smtpPort, setSmtpPort] = useState('587');
  const [smtpSecure, setSmtpSecure] = useState(false);
  const [smtpUser, setSmtpUser] = useState('');
  const [smtpPass, setSmtpPass] = useState('');
  const [pmToken, setPmToken] = useState('');
  const [pmStream, setPmStream] = useState('outbound');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!data) return;
    setKind(data.kind ?? 'smtp');
    setFrom(data.from ?? '');
    if (data.smtp) {
      setSmtpHost(data.smtp.host);
      setSmtpPort(String(data.smtp.port));
      setSmtpSecure(data.smtp.secure);
      setSmtpUser(data.smtp.user ?? '');
    }
    if (data.postmark) {
      setPmStream(data.postmark.messageStream);
    }
  }, [data]);

  const mut = useMutation({
    mutationFn: () =>
      api<PublicMailSettings>('/config/mail', {
        method: 'POST',
        body: {
          kind,
          from: from || undefined,
          smtp:
            kind === 'smtp'
              ? {
                  host: smtpHost || undefined,
                  port: smtpPort ? Number(smtpPort) : undefined,
                  secure: smtpSecure,
                  user: smtpUser || undefined,
                  password: smtpPass || undefined,
                }
              : undefined,
          postmark:
            kind === 'postmark'
              ? { serverToken: pmToken || undefined, messageStream: pmStream || undefined }
              : undefined,
        },
      }),
    onSuccess: () => {
      setSmtpPass('');
      setPmToken('');
      qc.invalidateQueries({ queryKey: ['mail-settings'] });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    },
  });

  if (isLoading) return <Card>Loading…</Card>;

  const hasStoredSmtpPassword = data?.smtp?.hasPassword ?? false;
  const hasStoredPmToken = data?.postmark?.hasToken ?? false;

  return (
    <Card>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
        <Mail size={18} color={theme.accent} />
        <div style={{ fontSize: 15, fontWeight: 500 }}>Email delivery</div>
      </div>
      <ErrorBanner error={error ?? mut.error} />
      <div
        style={{
          background: theme.successSoft,
          border: `1px solid ${theme.success}55`,
          borderRadius: theme.radiusSm,
          padding: 12,
          marginBottom: 14,
        }}
      >
        <div style={{ fontSize: 14, fontWeight: 500, color: theme.success, marginBottom: 4 }}>
          Email is set up by default
        </div>
        <div style={{ fontSize: 13, color: theme.textMuted, lineHeight: 1.55 }}>
          Partner invites, sign-in links, and notifications send through OpenPartner&rsquo;s
          email infrastructure as <code>&ldquo;Your brand via OpenPartner&rdquo; &lt;noreply@openpartner.dev&gt;</code>.
          Replies go to your support email if you&rsquo;ve set one. This section is optional —
          configure your own SMTP or Postmark only if you want emails to come from your
          own domain.
        </div>
      </div>

      <div style={{ marginTop: 14, marginBottom: 12 }}>
        <Label>Provider</Label>
        <Select value={kind} onChange={(e) => setKind(e.target.value as MailKind)}>
          <option value="smtp">SMTP (Gmail, SES, Mailgun, SendGrid, Postfix, …)</option>
          <option value="postmark">Postmark HTTP API</option>
          <option value="none">None — fall through to env / console</option>
        </Select>
      </div>

      {kind !== 'none' && (
        <div style={{ marginBottom: 12 }}>
          <Label>"From" address</Label>
          <Input type="email" value={from} onChange={(e) => setFrom(e.target.value)} placeholder='"Acme Partners" <partners@acme.com>' />
        </div>
      )}
      {kind === 'smtp' && (
        <>
          <div className="op-grid-collapse" style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 12, marginBottom: 12 }}>
            <div>
              <Label>SMTP host</Label>
              <Input value={smtpHost} onChange={(e) => setSmtpHost(e.target.value)} placeholder="smtp.example.com" />
            </div>
            <div>
              <Label>Port</Label>
              <Input value={smtpPort} onChange={(e) => setSmtpPort(e.target.value)} placeholder="587" />
            </div>
          </div>
          <div style={{ marginBottom: 12 }}>
            <Label>Username (optional)</Label>
            <Input value={smtpUser} onChange={(e) => setSmtpUser(e.target.value)} placeholder="apikey or username" />
          </div>
          <div style={{ marginBottom: 12 }}>
            <Label>
              Password{' '}
              {hasStoredSmtpPassword && (
                <span style={{ color: theme.textDim, fontWeight: 400, fontSize: 12 }}>— saved ✓ (enter to rotate)</span>
              )}
            </Label>
            <Input
              type="password"
              value={smtpPass}
              onChange={(e) => setSmtpPass(e.target.value)}
              placeholder={hasStoredSmtpPassword ? '•••••••• (leave blank to keep)' : ''}
            />
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: theme.textMuted, marginBottom: 16 }}>
            <input type="checkbox" checked={smtpSecure} onChange={(e) => setSmtpSecure(e.target.checked)} />
            Use implicit TLS (port 465). Leave unchecked for STARTTLS on 587.
          </label>
        </>
      )}
      {kind === 'postmark' && (
        <>
          <div style={{ marginBottom: 12 }}>
            <Label>
              Server token{' '}
              {hasStoredPmToken && (
                <span style={{ color: theme.textDim, fontWeight: 400, fontSize: 12 }}>— saved ✓ (enter to rotate)</span>
              )}
            </Label>
            <Input
              type="password"
              value={pmToken}
              onChange={(e) => setPmToken(e.target.value)}
              placeholder={hasStoredPmToken ? '•••••••• (leave blank to keep)' : ''}
            />
          </div>
          <div style={{ marginBottom: 16 }}>
            <Label>Message stream</Label>
            <Input value={pmStream} onChange={(e) => setPmStream(e.target.value)} placeholder="outbound" />
          </div>
        </>
      )}

      <Row>
        <Button onClick={() => mut.mutate()} disabled={mut.isPending}>
          {mut.isPending ? 'Saving…' : 'Save mail settings'}
        </Button>
        {saved && <span style={{ color: theme.success, fontSize: 13 }}>Saved.</span>}
      </Row>
    </Card>
  );
}

function Row({ children }: { children: ReactNode }) {
  return <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>{children}</div>;
}

function Hint({ children }: { children: ReactNode }) {
  return <div style={{ fontSize: 12, color: theme.textDim, marginTop: 6 }}>{children}</div>;
}

function LogoUploader({ logoUrl, brandName }: { logoUrl: string | null; brandName: string | null }) {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const upload = useMutation({
    mutationFn: (file: File) =>
      api<{ logoUrl: string }>('/uploads/logo', { method: 'POST', body: file }),
    onSuccess: () => {
      setError(null);
      qc.invalidateQueries({ queryKey: ['program-settings'] });
      qc.invalidateQueries({ queryKey: ['session-home'] });
    },
    onError: (err) => setError(err instanceof Error ? err.message : 'upload failed'),
  });

  const onPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) {
      setError('Image too large — max 2 MB.');
      return;
    }
    upload.mutate(file);
  };

  return (
    <div style={{ marginBottom: 16, display: 'flex', alignItems: 'center', gap: 14 }}>
      <div
        style={{
          width: 56,
          height: 56,
          borderRadius: theme.radiusSm,
          background: theme.surface2,
          border: `1px solid ${theme.borderSubtle}`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          overflow: 'hidden',
          flexShrink: 0,
        }}
      >
        {logoUrl ? (
          <img src={logoUrl} alt={brandName ?? 'Brand logo'} style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
        ) : (
          <span style={{ fontSize: 22, fontWeight: 600, color: theme.accent }}>
            {brandName?.charAt(0).toUpperCase() ?? '?'}
          </span>
        )}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <Label>Brand logo</Label>
        <div>
          <label style={{ display: 'inline-block' }}>
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp"
              onChange={onPick}
              style={{ display: 'none' }}
              disabled={upload.isPending}
            />
            <span
              style={{
                display: 'inline-block',
                padding: '6px 12px',
                background: theme.surface2,
                border: `1px solid ${theme.border}`,
                borderRadius: theme.radiusSm,
                fontSize: 13,
                color: theme.text,
                cursor: upload.isPending ? 'wait' : 'pointer',
                opacity: upload.isPending ? 0.6 : 1,
              }}
            >
              {upload.isPending ? 'Uploading…' : logoUrl ? 'Replace logo' : 'Upload logo'}
            </span>
          </label>
        </div>
        <Hint>PNG, JPEG, or WebP. Max 2 MB. Square images render best in the sidebar (we display ~28×28).</Hint>
        {error && <div style={{ marginTop: 6, fontSize: 12, color: theme.danger }}>{error}</div>}
      </div>
    </div>
  );
}

// ---------- danger zone ----------

interface DeletionStatus {
  pendingDeletionAt: string | null;
  deletionReason: string | null;
  graceWindowDays: number;
  hardDeleteAt: string | null;
}

function DangerZone() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['account-deletion-status'],
    queryFn: () => api<DeletionStatus>('/account/deletion-status'),
  });

  const [confirmSlug, setConfirmSlug] = useState('');
  const [reason, setReason] = useState('');
  const [showForm, setShowForm] = useState(false);

  const del = useMutation({
    mutationFn: () => api('/account/delete', { method: 'POST', body: { confirmSlug, reason: reason || undefined } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['account-deletion-status'] });
      setShowForm(false);
      setConfirmSlug('');
      setReason('');
    },
  });

  const restore = useMutation({
    mutationFn: () => api('/account/restore', { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['account-deletion-status'] }),
  });

  if (isLoading) return null;

  const pending = !!data?.pendingDeletionAt;

  return (
    <Card>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
        <div style={{ fontSize: 15, fontWeight: 500, color: theme.danger }}>Danger zone</div>
      </div>

      {pending ? (
        <>
          <div style={{ background: `${theme.danger}15`, border: `1px solid ${theme.danger}55`, padding: 14, borderRadius: 6, marginBottom: 14 }}>
            <div style={{ fontSize: 14, fontWeight: 500, color: theme.danger }}>
              Account scheduled for deletion
            </div>
            <div style={{ fontSize: 13, color: theme.textMuted, marginTop: 6 }}>
              All data will be permanently deleted on{' '}
              <strong>{data?.hardDeleteAt ? new Date(data.hardDeleteAt).toLocaleDateString() : '—'}</strong>.
              You can recover any time before then.
            </div>
            {data?.deletionReason && (
              <div style={{ fontSize: 12, color: theme.textDim, marginTop: 8 }}>
                Reason on file: {data.deletionReason}
              </div>
            )}
          </div>
          <ErrorBanner error={restore.error} />
          <Button onClick={() => restore.mutate()} disabled={restore.isPending}>
            {restore.isPending ? 'Restoring…' : 'Recover account'}
          </Button>
        </>
      ) : !showForm ? (
        <>
          <Hint>
            Deleting permanently removes your brand workspace, partners, links, commissions,
            and payouts after a 30-day grace period. You&rsquo;ll be locked out immediately;
            inside the grace window you can recover. Stripe billing cancels at the end of
            the current period.
          </Hint>
          <div style={{ marginTop: 14, display: 'flex', gap: 8 }}>
            <a
              href="/api/export.json"
              style={{
                background: 'transparent',
                color: theme.text,
                border: `1px solid ${theme.borderSubtle}`,
                borderRadius: theme.radiusSm,
                padding: '8px 14px',
                fontSize: 13,
                textDecoration: 'none',
                display: 'inline-flex',
                alignItems: 'center',
              }}
            >
              Download workspace data
            </a>
            <Button variant="secondary" onClick={() => setShowForm(true)}>Delete this account</Button>
          </div>
        </>
      ) : (
        <>
          <Hint>Type your URL slug to confirm. This locks you out immediately.</Hint>
          <div style={{ marginTop: 12, marginBottom: 12 }}>
            <Label>Confirm slug</Label>
            <Input value={confirmSlug} onChange={(e) => setConfirmSlug(e.target.value)} placeholder="your-slug" />
          </div>
          <div style={{ marginBottom: 14 }}>
            <Label>Reason (optional, helps us improve)</Label>
            <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Switching platforms, project ended, …" />
          </div>
          <ErrorBanner error={del.error} />
          <Row>
            <Button onClick={() => del.mutate()} disabled={del.isPending || !confirmSlug}>
              {del.isPending ? 'Deleting…' : 'Permanently delete'}
            </Button>
            <Button variant="secondary" onClick={() => setShowForm(false)}>Cancel</Button>
          </Row>
        </>
      )}
    </Card>
  );
}


