import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link2, Plus, ArrowRight, Check, Copy } from 'lucide-react';
import { api, currentTenantSlug, type Principal } from '../api.js';
import { theme } from '../theme.js';
import { TenantLink } from '../tenant-link.js';
import { usePublicBrand } from '../lib/useBrand.js';
import { Avatar, Button, Card, EmptyState, ErrorBanner, Input, Label, Page, Select, Table, formatDate } from '../ui.js';

/**
 * The full share URL for a link key, matching how the router resolves it:
 *   platform origin (path-based tenant) → https://app…/r/<slug>/<key>
 *   white-label custom domain           → https://portal.brand.com/r/<key>
 *   single-tenant self-host             → null (the portal origin doesn't
 *     necessarily serve /r; show the relative key and let the operator's
 *     own router URL apply)
 */
function useShareUrlBase(): string | null {
  const pathSlug = currentTenantSlug();
  const { tenantSlug } = usePublicBrand();
  if (pathSlug) return `${window.location.origin}/r/${pathSlug}`;
  if (tenantSlug && tenantSlug !== 'default') return `${window.location.origin}/r`;
  return null;
}

function CopyableShareLink({ linkKey, base }: { linkKey: string; base: string | null }) {
  const [copied, setCopied] = useState(false);
  if (!base) return <code style={{ color: theme.accent }}>/r/{linkKey}</code>;
  const url = `${base}/${linkKey}`;
  return (
    <button
      type="button"
      title="Copy share link"
      onClick={() => {
        void navigator.clipboard.writeText(url).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        background: 'transparent',
        border: 'none',
        padding: 0,
        cursor: 'pointer',
        fontFamily: theme.fontMono,
        fontSize: 13,
        color: theme.accent,
        whiteSpace: 'nowrap',
      }}
    >
      {url.replace(/^https?:\/\//, '')}
      {copied ? <Check size={13} style={{ color: theme.success }} /> : <Copy size={13} style={{ color: theme.textDim }} />}
    </button>
  );
}

interface LinkRow {
  id: string;
  linkKey: string;
  destinationUrl: string | null;
  programId: string;
  partnerId: string;
  createdAt: string;
}

interface Program {
  id: string;
  name: string;
  destinationUrl: string;
  deepLinkAllowedDomains: string | null;
}

export function LinksPage({ principal }: { principal: Principal }) {
  const queryPartnerId = new URLSearchParams(window.location.search).get('partnerId');
  const partnerId = principal.partnerId ?? queryPartnerId;
  const isAdmin = principal.role === 'admin';

  if (isAdmin && !partnerId) {
    return <AdminLinksHub />;
  }
  return <PartnerLinks partnerId={partnerId!} readOnly={isAdmin} />;
}

function AdminLinksHub() {
  const { data, error, isLoading } = useQuery({
    queryKey: ['partners'],
    queryFn: () => api<{ partners: Array<{ id: string; name: string; email: string }> }>('/partners'),
  });

  return (
    <Page title="Links" subtitle="Pick a partner to see the links they've created.">
      <ErrorBanner error={error} />
      {isLoading ? (
        <Card>Loading…</Card>
      ) : data?.partners.length === 0 ? (
        <EmptyState title="No partners yet" hint="Invite a partner — they create their own links." icon={<Link2 size={28} strokeWidth={1.25} />} />
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 }}>
          {data?.partners.map((p) => (
            <TenantLink
              key={p.id}
              to={`/links?partnerId=${p.id}`}
              style={{
                display: 'block',
                background: theme.surface,
                border: `1px solid ${theme.border}`,
                borderRadius: theme.radiusMd,
                padding: 16,
                transition: 'all 120ms',
              }}
              onMouseEnter={(e) => (e.currentTarget.style.borderColor = theme.accent)}
              onMouseLeave={(e) => (e.currentTarget.style.borderColor = theme.border)}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <Avatar name={p.name} size={32} />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: 14, fontWeight: 500 }}>{p.name}</div>
                  <div style={{ fontSize: 12, color: theme.textMuted }}>{p.email}</div>
                </div>
                <ArrowRight size={14} color={theme.textDim} />
              </div>
            </TenantLink>
          ))}
        </div>
      )}
    </Page>
  );
}

function PartnerLinks({ partnerId, readOnly }: { partnerId: string; readOnly: boolean }) {
  const qc = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);
  const shareBase = useShareUrlBase();

  const links = useQuery({
    queryKey: ['links', partnerId],
    queryFn: () => api<{ links: LinkRow[] }>(`/partners/${partnerId}/links`),
  });

  // Partners need this too — they pick a Program when creating a link
  // and we surface the inherited destination. /me/campaigns is the
  // partner-friendly read-only slice (no commission rules etc.).
  const campaigns = useQuery({
    queryKey: ['me-campaigns'],
    queryFn: () => api<{ programs: Program[] }>('/me/programs').catch(() => ({ programs: [] })),
  });

  return (
    <Page
      title="Links"
      subtitle={
        readOnly
          ? "Links this partner has created. Partners manage their own; admins view only."
          : "Your share links — the router turns /r/<key> into an attributed click."
      }
      actions={
        readOnly ? undefined : (
          <Button icon={<Plus size={14} />} onClick={() => setShowCreate(true)}>
            New link
          </Button>
        )
      }
    >
      <ErrorBanner error={links.error} />
      {showCreate && !readOnly && (
        <CreateLink
          partnerId={partnerId}
          campaigns={campaigns.data?.programs ?? []}
          onClose={() => setShowCreate(false)}
          onCreated={() => {
            setShowCreate(false);
            qc.invalidateQueries({ queryKey: ['links', partnerId] });
          }}
        />
      )}
      {links.isLoading ? (
        <Card>Loading…</Card>
      ) : (links.data?.links ?? []).length === 0 ? (
        <EmptyState
          title="No links yet"
          hint={readOnly ? "This partner hasn't created any links yet." : 'Create one to start capturing clicks.'}
          icon={<Link2 size={28} strokeWidth={1.25} />}
        />
      ) : (
        <Table
          columns={['Key', 'Destination', 'Program', 'Created']}
          rows={(links.data?.links ?? []).map((l) => {
            const campaign = campaigns.data?.programs.find((c) => c.id === l.programId);
            const dest = l.destinationUrl ?? campaign?.destinationUrl ?? '—';
            return [
              <CopyableShareLink linkKey={l.linkKey} base={shareBase} />,
              <span style={{ color: theme.textMuted, fontSize: 13 }}>
                {dest}
                {l.destinationUrl && (
                  <span style={{ color: theme.accent, fontSize: 11, marginLeft: 8 }}>(deep link)</span>
                )}
              </span>,
              <span>{campaign?.name ?? <code style={{ color: theme.textDim, fontSize: 12 }}>{l.programId.slice(0, 8)}…</code>}</span>,
              <span style={{ color: theme.textMuted }}>{formatDate(l.createdAt, { relative: true })}</span>,
            ];
          })}
        />
      )}
    </Page>
  );
}

function CreateLink({
  partnerId,
  campaigns,
  onClose,
  onCreated,
}: {
  partnerId: string;
  campaigns: Program[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const [linkKey, setLinkKey] = useState('');
  const [programId, setProgramId] = useState(campaigns[0]?.id ?? '');
  const [useDeepLink, setUseDeepLink] = useState(false);
  const [destinationOverride, setDestinationOverride] = useState('');

  const selectedProgram = campaigns.find((c) => c.id === programId);
  const deepLinkAllowed = !!selectedProgram?.deepLinkAllowedDomains;

  const mut = useMutation({
    mutationFn: () =>
      api(`/partners/${partnerId}/links`, {
        method: 'POST',
        body: {
          linkKey,
          programId,
          // Only send destinationUrl when the partner has explicitly
          // opted into a deep-link override on a  Program that allows it.
          destinationUrl: useDeepLink && destinationOverride ? destinationOverride : undefined,
        },
      }),
    onSuccess: onCreated,
  });

  return (
    <Card style={{ marginBottom: 16 }}>
      <div style={{ fontSize: 15, fontWeight: 500, marginBottom: 16 }}>New link</div>
      <ErrorBanner error={mut.error} />
      <div style={{ marginBottom: 14 }}>
        <Label>Program</Label>
        {campaigns.length === 0 ? (
          <Input value={programId} onChange={(e) => setProgramId(e.target.value)} placeholder="campaign id (ULID)" />
        ) : (
          <Select value={programId} onChange={(e) => setProgramId(e.target.value)}>
            {campaigns.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        )}
        {selectedProgram && (
          <div style={{ fontSize: 12, color: theme.textMuted, marginTop: 6 }}>
            Lands at <code style={{ color: theme.textMuted }}>{selectedProgram.destinationUrl}</code>
          </div>
        )}
      </div>
      <div style={{ marginBottom: 14 }}>
        <Label>Link key</Label>
        <Input value={linkKey} onChange={(e) => setLinkKey(e.target.value)} placeholder="ada" />
        <div style={{ fontSize: 12, color: theme.textDim, marginTop: 6 }}>
          Becomes <code style={{ color: theme.textDim }}>/r/{linkKey || 'your-key'}</code>.
        </div>
      </div>
      {deepLinkAllowed && (
        <div style={{ marginBottom: 16 }}>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, color: theme.text, marginBottom: 8 }}>
            <input type="checkbox" checked={useDeepLink} onChange={(e) => setUseDeepLink(e.target.checked)} />
            Deep-link to a specific page on the brand&rsquo;s site
          </label>
          {useDeepLink && (
            <>
              <Input
                type="url"
                value={destinationOverride}
                onChange={(e) => setDestinationOverride(e.target.value)}
                placeholder={`https://${selectedProgram?.deepLinkAllowedDomains?.split(',')[0]?.trim() ?? 'yourbrand.com'}/some/page`}
              />
              <div style={{ fontSize: 12, color: theme.textDim, marginTop: 6 }}>
                Must be on: {selectedProgram?.deepLinkAllowedDomains}
              </div>
            </>
          )}
        </div>
      )}
      <div style={{ display: 'flex', gap: 8 }}>
        <Button onClick={() => mut.mutate()} disabled={!linkKey || !programId || mut.isPending}>
          {mut.isPending ? 'Creating…' : 'Create link'}
        </Button>
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </Card>
  );
}
