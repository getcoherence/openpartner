import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Button, Card, ErrorBanner, Input, Label, Page, Textarea } from '../../ui.js';
import { theme } from '../../theme.js';
import { creatorApi, ApiError } from './creator-api.js';

type MyStatus = 'none' | 'pending' | 'approved' | 'rejected' | 'cancelled';

interface Offering {
  id: string;
  title: string;
  description: string | null;
  productUrl: string;
  vendorId: string;
  vendorName: string;
  terms: {
    commissionDescription?: string;
    cookieWindowDays?: number;
    payoutCadence?: string;
    bonuses?: string[];
  };
  createdAt: string;
  myStatus: MyStatus;
}

interface PartnershipForOffering {
  id: string;
  offeringId: string;
  shareUrl: string;
}

interface Whoami {
  creator: { id: string; handle: string | null } | null;
}

export function CreatorOfferingDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [message, setMessage] = useState('');
  const [preferredSlug, setPreferredSlug] = useState('');

  const { data: offering, isLoading, error } = useQuery({
    queryKey: ['creator-offering', id],
    queryFn: () => creatorApi<Offering>(`/offerings/${id}`),
    enabled: !!id,
    retry: false,
  });

  const { data: whoami } = useQuery({
    queryKey: ['creator-whoami'],
    queryFn: () => creatorApi<Whoami>('/creators/whoami'),
    retry: false,
  });

  const apply = useMutation({
    mutationFn: () =>
      creatorApi(`/offerings/${id}/apply`, {
        method: 'POST',
        body: { message: message || undefined, preferredSlug: preferredSlug || undefined },
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['creator-my-requests'] });
      navigate('/creator/requests');
    },
  });

  return (
    <Page title={offering?.title ?? 'Program'} subtitle={offering?.vendorName}>
      <ErrorBanner error={error} />
      {isLoading && <Card>Loading…</Card>}
      {offering && (
        <>
          <Card>
            {offering.terms.commissionDescription && (
              <p style={{ color: theme.textMuted, fontSize: 14 }}>{offering.terms.commissionDescription}</p>
            )}
            {offering.description && <p style={{ marginTop: 8 }}>{offering.description}</p>}
            <p style={{ marginTop: 12 }}>
              <a href={offering.productUrl} target="_blank" rel="noopener noreferrer">View product →</a>
            </p>
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginTop: 12, color: theme.textMuted, fontSize: 13 }}>
              {offering.terms.cookieWindowDays != null && <span>Cookie window: {offering.terms.cookieWindowDays} days</span>}
              {offering.terms.payoutCadence && <span>Payouts: {offering.terms.payoutCadence}</span>}
            </div>
          </Card>

          <div style={{ height: 18 }} />

          <ApplyOrStatusCard
            offering={offering}
            whoami={whoami}
            message={message}
            setMessage={setMessage}
            preferredSlug={preferredSlug}
            setPreferredSlug={setPreferredSlug}
            apply={apply}
          />
        </>
      )}
    </Page>
  );
}

interface ApplyOrStatusProps {
  offering: Offering;
  whoami: Whoami | undefined;
  message: string;
  setMessage: (v: string) => void;
  preferredSlug: string;
  setPreferredSlug: (v: string) => void;
  apply: ReturnType<typeof useMutation<unknown, Error, void>>;
}

function ApplyOrStatusCard({ offering, whoami, message, setMessage, preferredSlug, setPreferredSlug, apply }: ApplyOrStatusProps) {
  // Show approved share link when active partnership exists. Hide the
  // apply form for pending/cancelled (cancelled is rare; the creator
  // can still re-apply through the rejected path if needed).
  if (!whoami?.creator) {
    return (
      <Card>
        <h3 style={{ marginTop: 0 }}>Apply to promote</h3>
        <p style={{ color: theme.textMuted }}>
          <Link to="/creator/signup" style={{ color: theme.accent }}>Sign up</Link> or <Link to="/creator/login" style={{ color: theme.accent }}>sign in</Link> to apply.
        </p>
      </Card>
    );
  }

  if (offering.myStatus === 'approved') {
    return <ApprovedCard offering={offering} />;
  }

  if (offering.myStatus === 'pending') {
    return (
      <Card>
        <h3 style={{ marginTop: 0 }}>Application pending</h3>
        <p style={{ color: theme.textMuted, fontSize: 13 }}>
          You&rsquo;ve applied to {offering.vendorName} for this program. They&rsquo;ll review and you&rsquo;ll get an email when they decide.
          You can track it on <Link to="/creator/requests" style={{ color: theme.accent }}>My applications</Link>.
        </p>
      </Card>
    );
  }

  return (
    <Card>
      <h3 style={{ marginTop: 0 }}>{offering.myStatus === 'rejected' ? 'Re-apply' : 'Apply to promote'}</h3>
      {offering.myStatus === 'rejected' && (
        <p style={{ color: theme.textMuted, fontSize: 13, marginTop: 0 }}>
          Your previous application was declined. You can try again with a different pitch.
        </p>
      )}
      <ErrorBanner error={apply.error} />
      {apply.error instanceof ApiError && apply.error.message === 'request_already_exists' && (
        <p style={{ color: theme.textMuted, fontSize: 13 }}>You already have a pending or active request for this program.</p>
      )}
      <div style={{ marginTop: 8 }}>
        <Label>Preferred share-link slug (optional)</Label>
        <Input
          placeholder={whoami.creator.handle ?? 'your-handle'}
          value={preferredSlug}
          onChange={(e) => setPreferredSlug(e.target.value)}
        />
      </div>
      <div style={{ marginTop: 12 }}>
        <Label>Message to the vendor (optional)</Label>
        <Textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          rows={4}
          placeholder="Why you'd be a great partner…"
        />
      </div>
      <div style={{ marginTop: 12 }}>
        <Button onClick={() => apply.mutate()} disabled={apply.isPending}>
          {apply.isPending ? 'Applying…' : 'Submit application'}
        </Button>
      </div>
    </Card>
  );
}

/** Active partnership — fetch the share URL from /creators/me/partnerships
 *  and show it inline with a copy button. The flat partnerships endpoint
 *  already computes shareUrl (custom domain when verified, else the
 *  openpartner default). */
function ApprovedCard({ offering }: { offering: Offering }) {
  const [copied, setCopied] = useState(false);
  const { data } = useQuery({
    queryKey: ['creator-partnerships'],
    queryFn: () => creatorApi<{ partnerships: PartnershipForOffering[] }>('/creators/me/partnerships'),
    retry: false,
  });
  const partnership = data?.partnerships.find((p) => p.offeringId === offering.id);

  function copy() {
    if (!partnership) return;
    navigator.clipboard.writeText(partnership.shareUrl).then(
      () => { setCopied(true); setTimeout(() => setCopied(false), 1500); },
      () => {/* ignore */},
    );
  }

  return (
    <Card>
      <h3 style={{ marginTop: 0 }}>You&rsquo;re approved to promote this</h3>
      <p style={{ color: theme.textMuted, fontSize: 13 }}>
        Drop this share link on socials, in your newsletter, anywhere your audience hangs out.
      </p>
      {partnership ? (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            background: theme.surface2,
            border: `1px solid ${theme.borderSubtle}`,
            borderRadius: theme.radiusSm,
            padding: '10px 12px',
            marginTop: 12,
          }}
        >
          <code style={{ flex: 1, fontSize: 13, wordBreak: 'break-all' }}>{partnership.shareUrl}</code>
          <button
            onClick={copy}
            style={{
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
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      ) : (
        <p style={{ color: theme.textDim, fontSize: 13, marginTop: 12 }}>Loading share link…</p>
      )}
      <p style={{ marginTop: 12, fontSize: 12 }}>
        <Link to="/creator/links" style={{ color: theme.accent }}>Edit slug or copy from My share links →</Link>
      </p>
    </Card>
  );
}
