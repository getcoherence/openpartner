import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Copy, Megaphone } from 'lucide-react';
import { Button, Card, EmptyState, ErrorBanner, Input, Label, Page, formatDate } from '../../ui.js';
import { theme } from '../../theme.js';
import { creatorApi } from './creator-api.js';

interface Coupon {
  code: string;
  campaignId: string;
}

interface Partnership {
  id: string;
  vendorId: string;
  offeringId: string;
  creatorSlug: string;
  publicShareUrl: string;
  status: string;
  createdAt: string;
  vendorName: string;
  offeringTitle: string | null;
  shareUrl: string;
  customDomain: string | null;
  coupons: Coupon[];
}

export function CreatorShareLinksPage() {
  const list = useQuery({
    queryKey: ['creator-partnerships'],
    queryFn: () => creatorApi<{ partnerships: Partnership[] }>('/creators/me/partnerships'),
    retry: false,
  });

  const verified = list.data?.partnerships ?? [];
  const customDomain = verified[0]?.customDomain ?? null;

  return (
    <Page
      title="Share links"
      subtitle={
        customDomain
          ? `Branded with your domain ${customDomain}. Edit the slug per program below.`
          : 'Default openpartner.dev URLs. Add a custom domain in Domains to brand them.'
      }
    >
      <ErrorBanner error={list.error} />
      {list.isLoading ? (
        <Card>Loading…</Card>
      ) : verified.length === 0 ? (
        <EmptyState
          title="No share links yet"
          hint="Apply to a program to get your first share link."
          icon={<Megaphone size={28} strokeWidth={1.25} />}
        />
      ) : (
        verified.map((p) => <PartnershipRow key={p.id} partnership={p} />)
      )}
    </Page>
  );
}

function PartnershipRow({ partnership }: { partnership: Partnership }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [slug, setSlug] = useState(partnership.creatorSlug);
  const [copied, setCopied] = useState(false);

  const save = useMutation({
    mutationFn: () =>
      creatorApi(`/creators/me/partnerships/${partnership.id}`, {
        method: 'PATCH',
        body: { creatorSlug: slug.trim().toLowerCase() },
      }),
    onSuccess: () => {
      setEditing(false);
      qc.invalidateQueries({ queryKey: ['creator-partnerships'] });
    },
  });

  function copy() {
    navigator.clipboard.writeText(partnership.shareUrl).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => {/* ignore */},
    );
  }

  return (
    <Card>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 4 }}>
        <h3 style={{ marginTop: 0, marginBottom: 0, flex: 1 }}>
          <Link to={`/creator/vendors/${partnership.vendorId}`}>{partnership.vendorName}</Link>
        </h3>
        <span style={{ color: theme.textMuted, fontSize: 12 }}>
          {formatDate(partnership.createdAt, { relative: true })}
        </span>
      </div>
      {partnership.offeringTitle && (
        <p style={{ color: theme.textMuted, fontSize: 13, margin: '0 0 12px' }}>
          {partnership.offeringTitle}
        </p>
      )}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          background: theme.surface2,
          border: `1px solid ${theme.borderSubtle}`,
          borderRadius: theme.radiusSm,
          padding: '10px 12px',
          marginBottom: 8,
        }}
      >
        <code style={{ flex: 1, fontSize: 13, wordBreak: 'break-all' }}>{partnership.shareUrl}</code>
        <button
          onClick={copy}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            background: 'transparent',
            border: `1px solid ${theme.borderSubtle}`,
            borderRadius: 6,
            padding: '6px 10px',
            fontSize: 12,
            color: copied ? theme.success : theme.textMuted,
            cursor: 'pointer',
            whiteSpace: 'nowrap',
          }}
        >
          <Copy size={12} />
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      {partnership.coupons.length > 0 && (
        <div style={{ marginBottom: 8 }}>
          <div style={{ fontSize: 11, color: theme.textDim, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>
            Coupon code{partnership.coupons.length > 1 ? 's' : ''}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {partnership.coupons.map((c) => (
              <CouponRow key={c.code} code={c.code} />
            ))}
          </div>
          <p style={{ fontSize: 11, color: theme.textDim, margin: '6px 0 0' }}>
            Customers who enter this code at checkout get attributed to you, same commission as the share link.
          </p>
        </div>
      )}
      {editing ? (
        <div style={{ marginTop: 12 }}>
          <Label>Slug (path under your domain)</Label>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 4 }}>
            <Input
              value={slug}
              onChange={(e) => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
              placeholder="program-name"
              style={{ fontFamily: theme.fontMono, flex: 1 }}
            />
            <Button onClick={() => save.mutate()} disabled={save.isPending || !slug.trim() || slug === partnership.creatorSlug}>
              {save.isPending ? 'Saving…' : 'Save'}
            </Button>
            <Button variant="secondary" onClick={() => { setEditing(false); setSlug(partnership.creatorSlug); }}>
              Cancel
            </Button>
          </div>
          {save.error && (
            <div style={{ color: theme.danger, fontSize: 12, marginTop: 6 }}>
              {save.error instanceof Error ? save.error.message : 'Failed to save'}
            </div>
          )}
        </div>
      ) : (
        <div style={{ display: 'flex', gap: 14, alignItems: 'baseline' }}>
          <span style={{ color: theme.textMuted, fontSize: 12 }}>
            slug: <code>{partnership.creatorSlug}</code>
          </span>
          <button
            onClick={() => setEditing(true)}
            style={{ background: 'transparent', border: 'none', color: theme.accent, cursor: 'pointer', fontSize: 12, padding: 0 }}
          >
            Edit
          </button>
        </div>
      )}
    </Card>
  );
}

function CouponRow({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  function copy() {
    navigator.clipboard.writeText(code).then(
      () => { setCopied(true); setTimeout(() => setCopied(false), 1500); },
      () => {/* ignore */},
    );
  }
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        background: theme.surface2,
        border: `1px solid ${theme.borderSubtle}`,
        borderRadius: theme.radiusSm,
        padding: '6px 10px',
      }}
    >
      <code style={{ flex: 1, fontSize: 13, fontWeight: 500, color: theme.text, fontFamily: theme.fontMono }}>{code}</code>
      <button
        onClick={copy}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          background: 'transparent',
          border: `1px solid ${theme.borderSubtle}`,
          borderRadius: 6,
          padding: '4px 8px',
          fontSize: 11,
          color: copied ? theme.success : theme.textMuted,
          cursor: 'pointer',
        }}
      >
        <Copy size={11} />
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}
