import { useEffect, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Settings as SettingsIcon, Mail } from 'lucide-react';
import { api } from '../../api.js';
import { theme } from '../../theme.js';
import { Button, Card, ErrorBanner, Input, Label, Page, Select } from '../../ui.js';

interface ProgramSettings {
  programName: string | null;
  supportEmail: string | null;
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
    <Page title="Settings" subtitle="How the partner portal identifies your brand and how it sends mail.">
      <ProgramSection />
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
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!data) return;
    setProgramName(data.programName ?? '');
    setSupportEmail(data.supportEmail ?? '');
  }, [data]);

  const mut = useMutation({
    mutationFn: () =>
      api<ProgramSettings>('/config/program', { method: 'POST', body: { programName, supportEmail } }),
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
      <div style={{ marginBottom: 16 }}>
        <Label>Brand name</Label>
        <Input value={programName} onChange={(e) => setProgramName(e.target.value)} placeholder="e.g. Acme" maxLength={120} />
        <Hint>Shown to partners in the portal. Leave blank to fall back to "OpenPartner".</Hint>
      </div>
      <div style={{ marginBottom: 18 }}>
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
      <Row>
        <Button onClick={() => mut.mutate()} disabled={mut.isPending}>
          {mut.isPending ? 'Saving…' : 'Save program info'}
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
      <Hint>
        Used for partner invite / sign-in emails and admin magic-links. Credentials are
        encrypted at rest with <code>SECRETS_ENCRYPTION_KEY</code>. Leaving the UI empty
        falls back to <code>SMTP_*</code> / <code>POSTMARK_SERVER_TOKEN</code> env vars.
      </Hint>

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
          <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 12, marginBottom: 12 }}>
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


