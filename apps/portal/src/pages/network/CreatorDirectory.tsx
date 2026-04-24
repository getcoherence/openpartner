import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Megaphone, UserPlus, ExternalLink } from 'lucide-react';
import { api } from '../../api.js';
import { theme } from '../../theme.js';
import { Avatar, Button, Card, EmptyState, ErrorBanner, Input, Label, Page, Select } from '../../ui.js';

interface Platform {
  platform: string;
  url: string;
  followers?: number;
}

interface DirectoryCreator {
  id: string;
  name: string;
  handle: string;
  bio: string | null;
  avatarUrl: string | null;
  platforms: Platform[];
  createdAt: string;
}

interface VendorOffering {
  id: string;
  title: string;
}

const PROMO_CODE_REGEX = /^[a-zA-Z0-9_-]+$/;

export function CreatorDirectoryPage() {
  const { data, error, isLoading } = useQuery({
    queryKey: ['creator-directory'],
    queryFn: () => api<{ creators: DirectoryCreator[] }>('/network/directory/creators'),
  });

  const offerings = useQuery({
    queryKey: ['vendor-offerings'],
    queryFn: () => api<{ offerings: VendorOffering[] }>('/network/offerings/mine'),
  });

  const [invite, setInvite] = useState<DirectoryCreator | null>(null);

  return (
    <Page title="Discover creators" subtitle="Active promoters on the Network. Invite them to your offerings.">
      <ErrorBanner error={error} />
      {isLoading ? (
        <Card>Loading…</Card>
      ) : (data?.creators ?? []).length === 0 ? (
        <EmptyState title="No creators yet" hint="Creators show up here once they sign up and verify their email." icon={<Megaphone size={28} strokeWidth={1.25} />} />
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 16 }}>
          {(data?.creators ?? []).map((c) => (
            <CreatorCard key={c.id} creator={c} onInvite={() => setInvite(c)} />
          ))}
        </div>
      )}
      {invite && offerings.data && (
        <InviteDialog creator={invite} offerings={offerings.data.offerings} onClose={() => setInvite(null)} />
      )}
    </Page>
  );
}

function CreatorCard({ creator, onInvite }: { creator: DirectoryCreator; onInvite: () => void }) {
  const totalFollowers = (creator.platforms ?? []).reduce((sum, p) => sum + (p.followers ?? 0), 0);

  return (
    <Card>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
        <Avatar name={creator.name} size={40} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 15, fontWeight: 600 }}>{creator.name}</div>
          <div style={{ fontSize: 12, color: theme.textMuted }}>@{creator.handle}</div>
        </div>
      </div>
      {creator.bio && (
        <div style={{ fontSize: 13, color: theme.textMuted, lineHeight: 1.5, marginBottom: 12 }}>
          {creator.bio}
        </div>
      )}
      {(creator.platforms ?? []).length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
          {creator.platforms.map((p, i) => (
            <a
              key={i}
              href={p.url}
              target="_blank"
              rel="noreferrer"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                padding: '3px 8px',
                background: theme.bg,
                border: `1px solid ${theme.borderSubtle}`,
                borderRadius: 999,
                fontSize: 11,
                color: theme.textMuted,
              }}
            >
              {p.platform}
              {p.followers && <span style={{ color: theme.accent }}>{formatCount(p.followers)}</span>}
              <ExternalLink size={10} />
            </a>
          ))}
        </div>
      )}
      {totalFollowers > 0 && (
        <div style={{ fontSize: 12, color: theme.textDim, marginBottom: 12 }}>
          {formatCount(totalFollowers)} followers across platforms
        </div>
      )}
      <Button size="sm" icon={<UserPlus size={13} />} onClick={onInvite}>
        Invite
      </Button>
    </Card>
  );
}

function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function InviteDialog({
  creator,
  offerings,
  onClose,
}: {
  creator: DirectoryCreator;
  offerings: VendorOffering[];
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [offeringId, setOfferingId] = useState(offerings[0]?.id ?? '');
  const [message, setMessage] = useState('');
  const [promoCode, setPromoCode] = useState(creator.handle);

  const codeValid = promoCode.length >= 3 && promoCode.length <= 40 && PROMO_CODE_REGEX.test(promoCode);

  const mut = useMutation({
    mutationFn: () =>
      api('/network/invites', {
        method: 'POST',
        body: {
          offeringId,
          creatorId: creator.id,
          message: message || undefined,
          promoCode: promoCode || undefined,
        },
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['network-requests-mine'] });
      onClose();
    },
  });

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.6)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 50,
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: theme.surface,
          border: `1px solid ${theme.border}`,
          borderRadius: theme.radiusLg,
          padding: 24,
          width: 520,
          maxWidth: '90vw',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 18 }}>
          <Avatar name={creator.name} size={32} />
          <div>
            <div style={{ fontSize: 16, fontWeight: 600 }}>Invite {creator.name}</div>
            <div style={{ fontSize: 12, color: theme.textMuted }}>@{creator.handle}</div>
          </div>
        </div>
        <ErrorBanner error={mut.error} />

        {offerings.length === 0 ? (
          <div style={{ fontSize: 13, padding: 14, background: theme.warnSoft, borderRadius: theme.radiusSm, color: theme.warn }}>
            You have no offerings yet. Publish one in Offerings before inviting creators.
          </div>
        ) : (
          <>
            <Label>Offering</Label>
            <Select value={offeringId} onChange={(e) => setOfferingId(e.target.value)}>
              {offerings.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.title}
                </option>
              ))}
            </Select>

            <div style={{ marginTop: 14 }}>
              <Label>Share code you'd assign</Label>
              <Input value={promoCode} onChange={(e) => setPromoCode(e.target.value)} placeholder="creator_handle" />
              <div style={{ fontSize: 11, color: theme.textDim, marginTop: 4 }}>
                The creator sees this in their inbox and can reject the invite if they don't like it.
              </div>
            </div>

            <div style={{ marginTop: 14 }}>
              <Label>Message (optional)</Label>
              <textarea
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                rows={4}
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
                placeholder="Why you think they're a fit."
              />
            </div>
          </>
        )}

        <div style={{ display: 'flex', gap: 8, marginTop: 16, justifyContent: 'flex-end' }}>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => mut.mutate()} disabled={!codeValid || !offeringId || mut.isPending || offerings.length === 0}>
            {mut.isPending ? 'Sending…' : 'Send invite'}
          </Button>
        </div>
      </div>
    </div>
  );
}
