import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, Globe, RefreshCw, Trash2 } from 'lucide-react';
import { api, ApiError } from '../../api.js';
import { theme } from '../../theme.js';
import { Button, Card, ErrorBanner, Input, Label, Page, SectionHeading, StatusPill } from '../../ui.js';

/**
 * White-label wizard (spec Phase 3): enable the billing add-on, register a
 * custom domain, publish the two DNS records, verify. Everything here is
 * driven by /billing/white-label + /config/domain — the same endpoints ops
 * uses, so the concierge and self-serve paths can't drift.
 */

interface WhiteLabelBilling {
  provisioned: boolean;
  effective: boolean;
  plan: string | null;
  mode: string;
  subscribed: boolean;
  priceConfigured: boolean;
}

interface DnsInstructions {
  cname: { name: string; target: string };
  txt: { name: string; value: string };
  note: string;
}

interface DomainRow {
  id: string;
  domain: string;
  status: 'pending' | 'verified' | 'failed';
  edgeKind: string;
  verifiedAt: string | null;
  lastCheckedAt: string | null;
  dnsInstructions: DnsInstructions;
  edge?: string;
}

export function AdminWhiteLabel() {
  const billing = useQuery({
    queryKey: ['white-label-billing'],
    queryFn: () => api<WhiteLabelBilling>('/billing/white-label'),
  });
  const domains = useQuery({
    queryKey: ['white-label-domains'],
    queryFn: () => api<{ domains: DomainRow[] }>('/config/domain'),
    enabled: !!billing.data?.effective,
  });

  return (
    <Page
      title="White label"
      subtitle="Serve your partner portal from your own domain, with your brand only."
    >
      <ErrorBanner error={billing.error} />
      {billing.isLoading ? (
        <Card>Loading…</Card>
      ) : billing.data ? (
        <>
          <AddOnCard billing={billing.data} />
          <div style={{ height: 16 }} />
          {billing.data.effective && (
            <DomainsCard rows={domains.data?.domains ?? []} loading={domains.isLoading} />
          )}
        </>
      ) : null}
    </Page>
  );
}

function AddOnCard({ billing }: { billing: WhiteLabelBilling }) {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['white-label-billing'] });
    void qc.invalidateQueries({ queryKey: ['white-label-domains'] });
    void qc.invalidateQueries({ queryKey: ['program-settings'] });
    void qc.invalidateQueries({ queryKey: ['public-branding'] });
  };

  const enable = useMutation({
    mutationFn: () => api<{ ok: boolean }>('/billing/white-label', { method: 'POST' }),
    onSuccess: refresh,
    onError: (err) => {
      if (err instanceof ApiError && String(err.message).includes('subscription_required')) {
        setError('Activate your plan first — the add-on attaches to your subscription. Head to Billing, then come back.');
      } else {
        setError(err instanceof ApiError ? err.message : 'Could not enable the add-on.');
      }
    },
  });
  const disable = useMutation({
    mutationFn: () => api<{ ok: boolean }>('/billing/white-label', { method: 'DELETE' }),
    onSuccess: refresh,
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Could not disable the add-on.'),
  });

  const selfhost = billing.mode === 'selfhost';

  return (
    <Card>
      <SectionHeading
        actions={
          selfhost ? null : billing.provisioned ? (
            <Button
              variant="ghost"
              onClick={() => {
                if (
                  window.confirm(
                    'Disable white-label? Your custom domain will stop resolving and platform branding returns. The add-on is removed from your subscription with a prorated credit.',
                  )
                ) {
                  disable.mutate();
                }
              }}
              disabled={disable.isPending}
            >
              {disable.isPending ? 'Disabling…' : 'Disable add-on'}
            </Button>
          ) : (
            <Button onClick={() => enable.mutate()} disabled={enable.isPending || !billing.priceConfigured}>
              {enable.isPending ? 'Enabling…' : 'Enable white-label add-on'}
            </Button>
          )
        }
      >
        White-label add-on
      </SectionHeading>
      {error && <div style={{ color: theme.danger, fontSize: 13, marginBottom: 10 }}>{error}</div>}
      <div style={{ fontSize: 13, color: theme.textMuted, lineHeight: 1.6 }}>
        {selfhost ? (
          <>Self-hosted installs are always white-label entitled — configure your brand under Settings and skip this page.</>
        ) : billing.effective ? (
          <>
            <StatusPill status="active" /> Add-on active. Platform branding is removed, Network surfaces are
            hidden, and you can serve the portal from your own domain below.
          </>
        ) : billing.provisioned ? (
          <>
            <StatusPill status="warning" /> Add-on is provisioned but not currently entitled — check that your
            subscription is active on the Billing page. Your custom domain will stop resolving until billing is
            restored.
          </>
        ) : (
          <>
            Removes OpenPartner branding from your partner portal and emails, hides the shared Network, and
            serves everything from your own domain (e.g. <code>partners.yourbrand.com</code>). Billed monthly as
            an add-on to your plan subscription{billing.priceConfigured ? '' : ' — pricing not yet configured on this deployment; contact support'}.
          </>
        )}
      </div>
    </Card>
  );
}

function DomainsCard({ rows, loading }: { rows: DomainRow[]; loading: boolean }) {
  const qc = useQueryClient();
  const [domain, setDomain] = useState('');
  const [error, setError] = useState<string | null>(null);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['white-label-domains'] });
    void qc.invalidateQueries({ queryKey: ['public-branding'] });
  };

  const register = useMutation({
    mutationFn: (d: string) => api<DomainRow>('/config/domain', { method: 'POST', body: { domain: d } }),
    onSuccess: () => {
      setDomain('');
      setError(null);
      refresh();
    },
    onError: (err) => setError(friendlyDomainError(err)),
  });

  return (
    <Card>
      <SectionHeading>Custom domain</SectionHeading>
      {rows.length === 0 && (
        <div style={{ fontSize: 13, color: theme.textMuted, marginBottom: 12, lineHeight: 1.6 }}>
          Use a subdomain you own, like <code>partners.yourbrand.com</code>. After registering you&rsquo;ll get
          two DNS records to publish; once they resolve, hit Verify and TLS is provisioned automatically.
        </div>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (domain.trim()) register.mutate(domain.trim().toLowerCase());
        }}
        style={{ display: 'flex', gap: 8, marginBottom: rows.length > 0 ? 18 : 0, maxWidth: 480 }}
      >
        <Input
          value={domain}
          onChange={(e) => setDomain(e.target.value)}
          placeholder="partners.yourbrand.com"
          style={{ flex: 1 }}
        />
        <Button type="submit" disabled={register.isPending || !domain.trim()}>
          {register.isPending ? 'Registering…' : 'Register'}
        </Button>
      </form>
      {error && <div style={{ color: theme.danger, fontSize: 13, marginBottom: 10 }}>{error}</div>}
      {loading && <div style={{ fontSize: 13, color: theme.textMuted }}>Loading…</div>}
      {rows.map((row) => (
        <DomainRowView key={row.id} row={row} onChanged={refresh} />
      ))}
    </Card>
  );
}

function DomainRowView({ row, onChanged }: { row: DomainRow; onChanged: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [verifyNote, setVerifyNote] = useState<string | null>(null);

  const verify = useMutation({
    mutationFn: () => api<DomainRow & { edge?: string }>(`/config/domain/${row.id}/verify`, { method: 'POST' }),
    onSuccess: (r) => {
      setError(null);
      setVerifyNote(
        r.edge === 'skipped' || r.edge === 'failed'
          ? 'Verified — but the edge registration needs an operator (DO automation unavailable). Support has been signalled via logs.'
          : 'Verified. TLS is being provisioned — the domain typically goes live within a few minutes.',
      );
      onChanged();
    },
    onError: (err) => {
      setVerifyNote(null);
      setError(
        err instanceof ApiError && String(err.message).includes('verification_failed')
          ? 'DNS records not visible yet. Note: the TXT value ROTATES on each failed attempt — copy the current value below before retrying.'
          : friendlyDomainError(err),
      );
      onChanged(); // token rotated server-side — refresh the shown TXT value
    },
  });
  const remove = useMutation({
    mutationFn: () => api<{ ok: boolean }>(`/config/domain/${row.id}`, { method: 'DELETE' }),
    onSuccess: onChanged,
    onError: (err) => setError(friendlyDomainError(err)),
  });

  return (
    <div
      style={{
        border: `1px solid ${theme.borderSubtle}`,
        borderRadius: theme.radiusSm,
        padding: 14,
        marginBottom: 10,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <Globe size={15} style={{ color: theme.textMuted }} />
        <span style={{ fontWeight: 600, fontSize: 14 }}>{row.domain}</span>
        <StatusPill status={row.status === 'verified' ? 'active' : row.status} />
        <span style={{ flex: 1 }} />
        <Button variant="ghost" onClick={() => verify.mutate()} disabled={verify.isPending}>
          <RefreshCw size={13} /> {verify.isPending ? 'Checking…' : row.status === 'verified' ? 'Re-verify' : 'Verify'}
        </Button>
        <Button
          variant="ghost"
          onClick={() => {
            if (window.confirm(`Remove ${row.domain}? The portal stops serving from this domain immediately.`)) {
              remove.mutate();
            }
          }}
          disabled={remove.isPending}
        >
          <Trash2 size={13} />
        </Button>
      </div>
      {error && <div style={{ color: theme.danger, fontSize: 13, marginTop: 8 }}>{error}</div>}
      {verifyNote && <div style={{ color: theme.success, fontSize: 13, marginTop: 8 }}>{verifyNote}</div>}
      <div style={{ marginTop: 12 }}>
        <Label>DNS records to publish (the TXT must stay in place permanently)</Label>
        <DnsRecord kind="CNAME" name={row.dnsInstructions.cname.name} value={row.dnsInstructions.cname.target} />
        <DnsRecord kind="TXT" name={row.dnsInstructions.txt.name} value={row.dnsInstructions.txt.value} />
      </div>
      {row.status === 'verified' && row.verifiedAt && (
        <div style={{ fontSize: 12, color: theme.textDim, marginTop: 8 }}>
          Verified {new Date(row.verifiedAt).toLocaleString()} · ownership re-checked daily
        </div>
      )}
    </div>
  );
}

function DnsRecord({ kind, name, value }: { kind: string; name: string; value: string }) {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = (text: string, which: string) => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(which);
      setTimeout(() => setCopied(null), 1500);
    });
  };
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        fontFamily: theme.fontMono,
        fontSize: 12,
        background: theme.surface2,
        border: `1px solid ${theme.borderSubtle}`,
        borderRadius: 6,
        padding: '8px 10px',
        marginTop: 6,
        overflowX: 'auto',
      }}
    >
      <span style={{ color: theme.accent, minWidth: 46 }}>{kind}</span>
      <CopyChunk text={name} copied={copied === 'name'} onCopy={() => copy(name, 'name')} />
      <span style={{ color: theme.textDim }}>→</span>
      <CopyChunk text={value} copied={copied === 'value'} onCopy={() => copy(value, 'value')} />
    </div>
  );
}

function CopyChunk({ text, copied, onCopy }: { text: string; copied: boolean; onCopy: () => void }) {
  return (
    <button
      type="button"
      onClick={onCopy}
      title="Copy"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        background: 'transparent',
        border: 'none',
        color: theme.text,
        fontFamily: 'inherit',
        fontSize: 'inherit',
        cursor: 'pointer',
        padding: 0,
        whiteSpace: 'nowrap',
      }}
    >
      {text}
      {copied ? <Check size={12} style={{ color: theme.success }} /> : <Copy size={12} style={{ color: theme.textDim }} />}
    </button>
  );
}

function friendlyDomainError(err: unknown): string {
  const code = err instanceof ApiError ? String(err.message) : '';
  if (code.includes('domain_taken')) return 'That domain is already registered to another workspace.';
  if (code.includes('subdomain_required')) return 'Apex domains aren’t supported yet — use a subdomain like partners.yourbrand.com.';
  if (code.includes('reserved_host')) return 'That hostname is reserved.';
  if (code.includes('invalid_domain')) return 'That doesn’t look like a valid hostname.';
  if (code.includes('white_label_not_entitled')) return 'The white-label add-on isn’t active — enable it above first.';
  return code || 'Something went wrong.';
}
