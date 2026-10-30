/**
 * /creator/claim?token=… — where the creator index's invite email lands
 * (openpartner-network docs/creator-index.md §5.3). Brands wanted to work
 * with a creator who isn't on OpenPartner yet; claiming the free profile
 * opens each brand's message as a conversation.
 *
 *   - Signed in already: the profile is claimed into that account.
 *   - Not signed in, and no account at the address the email went to: one is
 *     made for it, and the creator is signed in (the link proves the inbox).
 *   - An account exists at that address: sign in first, then use the link
 *     again.
 *
 * Nothing happens without a click, so mail scanners that prefetch links
 * can't claim. The page also shows what OpenPartner holds and where it came
 * from, with the way to remove it.
 */

import { useNavigate, useSearchParams } from 'react-router';
import { useMutation, useQuery } from '@tanstack/react-query';
import { MessagesSquare } from 'lucide-react';
import { Button, Card } from '../../ui.js';
import { theme } from '../../theme.js';
import { ApiError, creatorApi } from './creator-api.js';

interface ClaimPreview {
  creator: {
    name: string | null;
    headline: string | null;
    avatarUrl: string | null;
    email: string | null;
    emailFoundOn: string | null;
    firstSeenAt: string;
    platforms: Array<{ platform: string; handle: string | null; profileUrl: string; followerCount: number | null }>;
  };
  invites: Array<{ brand: string; logoUrl: string | null; preview: string }>;
  expiresAt: string;
}

interface ClaimResult {
  ok: true;
  creatorId: string;
  created: boolean;
  conversationIds: string[];
}

const PLATFORM_LABEL: Record<string, string> = { linkedin: 'LinkedIn', twitter: 'X', youtube: 'YouTube', substack: 'Substack' };

const ERRORS: Record<string, string> = {
  invalid_or_expired: 'This link has expired or isn’t valid. Links from our emails work for 30 days.',
  already_claimed: 'This profile has already been claimed. Sign in to read your messages.',
  creator_unavailable: 'This account can’t claim the profile right now.',
};

function codeOf(err: unknown): string | null {
  return err instanceof ApiError ? ((err.detail as { error?: string } | null)?.error ?? null) : null;
}

export function CreatorIndexClaimPage() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const navigate = useNavigate();

  const preview = useQuery({
    queryKey: ['creator-index-claim', token],
    queryFn: () => creatorApi<ClaimPreview>('/creator-index/claim/preview', { method: 'POST', body: { token } }),
    enabled: token.length > 0,
    retry: false,
  });

  const claim = useMutation({
    mutationFn: () => creatorApi<ClaimResult>('/creator-index/claim', { method: 'POST', body: { token } }),
    onSuccess: (r) => {
      const first = r.conversationIds[0];
      navigate(first ? `/creator/messages/${first}` : '/creator/messages');
    },
  });

  const claimCode = codeOf(claim.error);
  const previewCode = codeOf(preview.error);
  const existingEmail = claimCode === 'sign_in_required' ? ((claim.error as ApiError).detail as { email?: string } | null)?.email ?? null : null;
  const p = preview.data;

  return (
    <div style={{ minHeight: '100vh', background: theme.bg, padding: '64px 20px' }}>
      <div style={{ maxWidth: 560, margin: '0 auto' }}>
        <Card>
          {!token || preview.error ? (
            <>
              <div style={{ fontSize: 17, fontWeight: 600 }}>Brands want to work with you</div>
              <div style={{ marginTop: 12, fontSize: 14, color: theme.danger, background: theme.dangerSoft, borderRadius: theme.radiusSm, padding: '10px 12px' }}>
                {(previewCode && ERRORS[previewCode]) || ERRORS.invalid_or_expired}
              </div>
              {previewCode === 'already_claimed' && (
                <div style={{ marginTop: 14 }}>
                  <Button onClick={() => navigate('/creator/login')}>Sign in</Button>
                </div>
              )}
            </>
          ) : !p ? (
            <div style={{ fontSize: 14, color: theme.textMuted }}>Loading…</div>
          ) : (
            <>
              <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start' }}>
                {p.creator.avatarUrl ? (
                  <img src={p.creator.avatarUrl} alt="" style={{ width: 48, height: 48, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }} />
                ) : (
                  <MessagesSquare size={28} strokeWidth={1.5} style={{ color: theme.accentText, flexShrink: 0 }} />
                )}
                <div>
                  <div style={{ fontSize: 17, fontWeight: 600 }}>
                    {p.invites.length === 1 ? `${p.invites[0]!.brand} wants to work with you` : `${p.invites.length} brands want to work with you`}
                  </div>
                  <div style={{ fontSize: 14, color: theme.textMuted, marginTop: 6, lineHeight: 1.5 }}>
                    Claim your free OpenPartner profile to read and reply. Brands never see your email address.
                  </div>
                </div>
              </div>

              <div style={{ marginTop: 18, display: 'grid', gap: 10 }}>
                {p.invites.map((i, n) => (
                  <div key={n} style={{ border: `1px solid ${theme.borderSubtle}`, borderRadius: theme.radiusSm, padding: '10px 12px' }}>
                    <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>{i.brand}</div>
                    <div style={{ fontSize: 13, color: theme.textMuted, whiteSpace: 'pre-wrap' }}>{i.preview}</div>
                  </div>
                ))}
              </div>

              {claimCode === 'sign_in_required' ? (
                <div style={{ marginTop: 18, fontSize: 14, lineHeight: 1.5 }}>
                  You already have an OpenPartner account{existingEmail ? ` at ${existingEmail}` : ''}. Sign in, then open this link
                  from the email again to claim the profile into it.
                  <div style={{ marginTop: 12 }}>
                    <Button onClick={() => navigate('/creator/login')}>Sign in</Button>
                  </div>
                </div>
              ) : (
                <>
                  {claim.error && (
                    <div style={{ marginTop: 14, fontSize: 14, color: theme.danger, background: theme.dangerSoft, borderRadius: theme.radiusSm, padding: '10px 12px' }}>
                      {(claimCode && ERRORS[claimCode]) || 'Something went wrong. Try again in a moment.'}
                    </div>
                  )}
                  <div style={{ marginTop: 18 }}>
                    <Button onClick={() => claim.mutate()} disabled={claim.isPending}>
                      {claim.isPending ? 'Claiming…' : 'Claim my profile and read'}
                    </Button>
                  </div>
                </>
              )}

              <div style={{ marginTop: 24, paddingTop: 16, borderTop: `1px solid ${theme.borderSubtle}`, fontSize: 12, color: theme.textMuted, lineHeight: 1.6 }}>
                <div style={{ fontWeight: 600, marginBottom: 4 }}>What we hold</div>
                We listed {p.creator.name ?? 'you'} from your public{' '}
                {p.creator.platforms.map((pl) => PLATFORM_LABEL[pl.platform] ?? pl.platform).join(' and ')} profile
                {p.creator.platforms.length === 1 ? '' : 's'}
                {p.creator.email && p.creator.emailFoundOn ? <>, and found {p.creator.email} on {p.creator.emailFoundOn}</> : null}. Claiming moves
                it into your own account; anything you don&rsquo;t want, you can change there. The email we sent has a link to remove the listing
                instead.
              </div>
            </>
          )}
        </Card>
      </div>
    </div>
  );
}
