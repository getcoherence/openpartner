/**
 * /creator/claim?token=… — where the creator index's emails land
 * (openpartner-network docs/creator-index.md §5.3, §5.5). Brands wanted to
 * work with a creator who isn't on OpenPartner yet, and claiming the free
 * profile opens each brand's message as a conversation. Or no brand has
 * written yet (the "claim your profile" email), and the creator lands in
 * their new account.
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
 *
 * For most creators it's their first sight of OpenPartner, from an email
 * they didn't ask for, so it reads as a landing page: who we are (linking to
 * openpartner.dev), their profile as brands would see it, and what an
 * account gets them.
 *
 * A new account starts with the password chosen here, so the creator can
 * sign in again without another email. Signed in already, they claim into
 * that account and keep its password.
 */

import { useState, type FormEvent, type ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ArrowUpRight, Check, EyeOff, HandCoins, MessagesSquare, Store, UserRound } from 'lucide-react';
import { Button } from '../../ui.js';
import { theme } from '../../theme.js';
import { ThemeToggle } from '../../lib/ThemeToggle.js';
import { CookieSettingsButton } from '../../lib/ConsentBanner.js';
import { useIsMobile } from '../../lib/useMediaQuery.js';
import { ChannelCount, ChannelCounts } from '../../lib/PlatformMark.js';
import { ApiError, creatorApi } from './creator-api.js';
import { MIN_PASSWORD_LENGTH, PasswordInput } from '../auth/PasswordAuth.js';
import { brandSignalLabel, creatorSignalLabel, shortUrl, type PartnershipSignal } from '../../lib/partnership-signals.js';

interface ClaimPreview {
  creator: {
    name: string | null;
    headline: string | null;
    avatarUrl: string | null;
    email: string | null;
    emailFoundOn: string | null;
    firstSeenAt: string;
    platforms: Array<{
      platform: string;
      handle: string | null;
      profileUrl: string;
      followerCount: number | null;
      engagementRate?: number | null;
      engagementPosts?: number | null;
    }>;
    /** ISO 3166-1 alpha-2. */
    country?: string | null;
    categories?: string[];
    topics?: string[];
    /** Why brands see them as open to partnerships, and where we read it. */
    partnershipSignals?: PartnershipSignal[];
    /** False while the listing is hidden from brands until they claim. */
    shownToBrands?: boolean;
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

interface Whoami {
  creator: { email: string } | null;
}

const PLATFORM_LABEL: Record<string, string> = { linkedin: 'LinkedIn', twitter: 'X', youtube: 'YouTube', substack: 'Substack' };

const SITE = 'https://openpartner.dev';

const ERRORS: Record<string, string> = {
  invalid_or_expired: 'This link has expired or isn’t valid. Links from our emails work for 30 days.',
  already_claimed: 'This profile has already been claimed. Sign in to read your messages.',
  creator_unavailable: 'This account can’t claim the profile right now.',
  invalid_body: `Passwords need at least ${MIN_PASSWORD_LENGTH} characters.`,
};

const HONORIFICS = new Set(['dr', 'mr', 'mrs', 'ms', 'mx', 'prof', 'sir']);
/** Words that start channel names, not people's. */
const NOT_NAMES = new Set(['the', 'a', 'an', 'my', 'your', 'our', 'official']);

/** "Jane" from "Dr. Jane Doe | Growth"; null when the first word doesn't
 *  look like a first name (a channel name, say). The Network's email
 *  greeting splits the name the same way. */
export function firstNameOf(full: string | null): string | null {
  if (!full) return null;
  const cleaned = full.split(/\s[|•·–—-]\s|[|•·(,]/)[0]!.trim();
  const words = cleaned.split(/\s+/).filter((w) => w && !HONORIFICS.has(w.toLowerCase().replace(/\.$/, '')));
  const first = words[0];
  if (!first || words.length < 2 || NOT_NAMES.has(first.toLowerCase())) return null;
  return /^\p{Lu}[\p{L}'’-]+$/u.test(first) ? first : null;
}

function codeOf(err: unknown): string | null {
  return err instanceof ApiError ? ((err.detail as { error?: string } | null)?.error ?? null) : null;
}

/** "United States" from "US"; the code itself where the browser has no name. */
function countryName(code: string): string {
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' }).of(code) ?? code;
  } catch {
    return code;
  }
}

export function CreatorIndexClaimPage() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const navigate = useNavigate();
  const isMobile = useIsMobile();

  const preview = useQuery({
    queryKey: ['creator-index-claim', token],
    queryFn: () => creatorApi<ClaimPreview>('/creator-index/claim/preview', { method: 'POST', body: { token } }),
    enabled: token.length > 0,
    retry: false,
  });

  // Signed in already: the claim goes into that account.
  const whoami = useQuery({
    queryKey: ['creator-whoami'],
    queryFn: () => creatorApi<Whoami>('/creators/whoami'),
    retry: false,
  });
  const [password, setPassword] = useState('');
  const [tried, setTried] = useState(false);

  const claim = useMutation({
    mutationFn: (body: { token: string; password?: string }) => creatorApi<ClaimResult>('/creator-index/claim', { method: 'POST', body }),
    onSuccess: (r) => {
      const first = r.conversationIds[0];
      // No brand was waiting: their new account, with its setup steps.
      navigate(first ? `/creator/messages/${first}` : '/creator');
    },
  });

  const claimCode = codeOf(claim.error);
  const previewCode = codeOf(preview.error);
  const existingEmail = claimCode === 'sign_in_required' ? ((claim.error as ApiError).detail as { email?: string } | null)?.email ?? null : null;
  const p = preview.data;

  if (!token || preview.error) {
    return (
      <Frame>
        <div style={{ maxWidth: 520, margin: isMobile ? '24px auto' : '72px auto', textAlign: 'center' }}>
          <h1 style={{ fontSize: 24, fontWeight: 700, margin: 0 }}>Your OpenPartner profile</h1>
          <div style={{ marginTop: 16, fontSize: 14, color: theme.danger, background: theme.dangerSoft, borderRadius: theme.radiusSm, padding: '10px 12px' }}>
            {(previewCode && ERRORS[previewCode]) || ERRORS.invalid_or_expired}
          </div>
          <div style={{ marginTop: 18, display: 'flex', gap: 10, justifyContent: 'center' }}>
            <Button onClick={() => navigate('/creator/login')}>Sign in</Button>
            {previewCode !== 'already_claimed' && (
              <Button variant="secondary" onClick={() => navigate('/creator/signup')}>
                Join free
              </Button>
            )}
          </div>
        </div>
      </Frame>
    );
  }

  // Who they are decides the form: until we know, there's none to fill.
  if (!p || whoami.isPending) {
    return (
      <Frame>
        <div style={{ padding: '72px 0', fontSize: 14, color: theme.textMuted, textAlign: 'center' }}>Loading…</div>
      </Frame>
    );
  }

  const signals = p.creator.partnershipSignals ?? [];
  const waiting = p.invites.length;
  const signedInAs = whoami.data?.creator?.email ?? null;
  // A new account, at the address we wrote to, starts with a password. With
  // no address the claim asks them to sign in instead.
  const needsPassword = !signedInAs && !!p.creator.email;
  const tooShort = needsPassword && password.length < MIN_PASSWORD_LENGTH;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTried(true);
    if (tooShort) return;
    claim.mutate(needsPassword ? { token, password } : { token });
  };
  const shown = p.creator.shownToBrands ?? true;
  const first = firstNameOf(p.creator.name);

  const headline =
    waiting === 0
      ? first
        ? `${first}, your creator profile is ready`
        : 'Your creator profile is ready'
      : waiting === 1
        ? `${p.invites[0]!.brand} wants to work with you`
        : `${waiting} brands want to work with you`;
  const lead =
    waiting > 0
      ? 'Claim your free OpenPartner profile to read and reply. Brands never see your email address.'
      : shown
        ? 'Claim it to allow brands to start working with you.'
        : 'It isn’t shown to brands until you claim it. Claiming is free, and you decide what it says.';

  return (
    <Frame>
      {/* Hero: what it is and the one thing to do, beside their profile. */}
      <section
        style={{
          display: 'grid',
          gridTemplateColumns: isMobile ? '1fr' : 'minmax(0, 1.15fr) minmax(0, 0.85fr)',
          gap: isMobile ? 28 : 56,
          alignItems: 'start',
          padding: isMobile ? '20px 0 8px' : '56px 0 24px',
        }}
      >
        <div>
          <div style={{ fontSize: 13, fontWeight: 600, color: theme.accentText, letterSpacing: '0.02em' }}>OpenPartner for creators</div>
          <h1 style={{ fontSize: isMobile ? 30 : 42, lineHeight: 1.12, fontWeight: 700, letterSpacing: '-0.02em', margin: '10px 0 0' }}>{headline}</h1>
          <p style={{ fontSize: isMobile ? 16 : 18, lineHeight: 1.5, color: theme.textMuted, margin: '14px 0 0', maxWidth: 520 }}>{lead}</p>

          {waiting > 0 && (
            <div style={{ marginTop: 20, display: 'grid', gap: 10 }}>
              {p.invites.map((i, n) => (
                <div key={n} style={{ background: theme.surface, border: `1px solid ${theme.border}`, borderRadius: theme.radiusSm, padding: '12px 14px' }}>
                  <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>{i.brand}</div>
                  <div style={{ fontSize: 13, color: theme.textMuted, whiteSpace: 'pre-wrap' }}>{i.preview}</div>
                </div>
              ))}
            </div>
          )}

          {claimCode === 'sign_in_required' ? (
            <div style={{ marginTop: 22, fontSize: 14, lineHeight: 1.5 }}>
              You already have an OpenPartner account{existingEmail ? ` at ${existingEmail}` : ''}. Sign in, then open this link from the
              email again to claim the profile into it.
              <div style={{ marginTop: 12 }}>
                <Button onClick={() => navigate('/creator/login')}>Sign in</Button>
              </div>
            </div>
          ) : (
            <>
              {claim.error && (
                <div style={{ marginTop: 16, fontSize: 14, color: theme.danger, background: theme.dangerSoft, borderRadius: theme.radiusSm, padding: '10px 12px' }}>
                  {(claimCode && ERRORS[claimCode]) || 'Something went wrong. Try again in a moment.'}
                </div>
              )}
              {whoami.isError ? (
                <div style={{ marginTop: 24, fontSize: 14, color: theme.textMuted }}>
                  We couldn&rsquo;t check whether you&rsquo;re signed in.
                  <div style={{ marginTop: 12 }}>
                    <Button variant="secondary" onClick={() => void whoami.refetch()}>
                      Try again
                    </Button>
                  </div>
                </div>
              ) : (
                <form onSubmit={submit} style={{ marginTop: 24, maxWidth: 420 }}>
                  {needsPassword ? (
                    <div style={{ display: 'grid', gap: 12, marginBottom: 18 }}>
                      {/* The address they'll sign in with, which password managers save it under. */}
                      <label style={{ display: 'grid', gap: 4 }}>
                        <span style={{ fontSize: 12, color: theme.textMuted }}>Email</span>
                        <input
                          type="email"
                          name="email"
                          autoComplete="username"
                          value={p.creator.email ?? ''}
                          readOnly
                          style={{
                            padding: '10px 12px',
                            fontSize: 14,
                            background: 'transparent',
                            border: `1px solid ${theme.border}`,
                            borderRadius: theme.radiusSm,
                            color: theme.textMuted,
                            boxSizing: 'border-box',
                            width: '100%',
                          }}
                        />
                      </label>
                      <label style={{ display: 'grid', gap: 4 }}>
                        <span style={{ fontSize: 12, color: theme.textMuted }}>Choose a password</span>
                        <PasswordInput value={password} onChange={setPassword} autoComplete="new-password" name="new-password" />
                        <span style={{ fontSize: 12, color: tried && tooShort ? theme.danger : theme.textDim }}>At least {MIN_PASSWORD_LENGTH} characters</span>
                      </label>
                    </div>
                  ) : signedInAs ? (
                    <div style={{ fontSize: 13, color: theme.textMuted, marginBottom: 14 }}>Signed in as {signedInAs}</div>
                  ) : null}
                  <Button
                    type="submit"
                    disabled={claim.isPending}
                    style={{ padding: '12px 22px', fontSize: 16, fontWeight: 600, width: isMobile ? '100%' : undefined }}
                  >
                    {claim.isPending ? 'Claiming…' : waiting ? 'Claim my profile and read' : 'Claim my profile'}
                  </Button>
                </form>
              )}
            </>
          )}

          <ul style={{ listStyle: 'none', padding: 0, margin: '22px 0 0', display: 'grid', gap: 8, fontSize: 14 }}>
            {['Free, with no cut of what you earn', 'Brands never see your email address', 'Change it or remove it any time'].map((t) => (
              <li key={t} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <Check size={16} strokeWidth={2.5} style={{ color: theme.accentText, flexShrink: 0 }} />
                {t}
              </li>
            ))}
          </ul>
        </div>

        <ProfileCard creator={p.creator} shown={shown} signals={signals} />
      </section>

      {/* What an account gets them. */}
      <section style={{ padding: isMobile ? '28px 0 8px' : '40px 0 8px' }}>
        <h2 style={{ fontSize: isMobile ? 20 : 24, fontWeight: 700, letterSpacing: '-0.01em', margin: 0 }}>What you get on OpenPartner</h2>
        <div className="op-grid-collapse" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 16, marginTop: 18 }}>
          <Tile icon={<MessagesSquare size={20} />} title="Brands come to you">
            Brands find you and write to you on OpenPartner. Your email address stays private.
          </Tile>
          <Tile icon={<Store size={20} />} title="Sell sponsorships" link={{ href: `${SITE}/creators/storefronts`, label: 'How storefronts work' }}>
            Your rate card with a booking button. Brands pay upfront, straight into your own Stripe account.
          </Tile>
          <Tile icon={<HandCoins size={20} />} title="Earn on every sale" link={{ href: `${SITE}/creators`, label: 'OpenPartner for creators' }}>
            Join brands’ partner programs and get credit when your audience buys, even weeks later.
          </Tile>
        </div>
      </section>

      {/* The storefront, shown rather than told. */}
      <section
        style={{
          display: 'grid',
          gridTemplateColumns: isMobile ? '1fr' : 'minmax(0, 0.8fr) minmax(0, 1.2fr)',
          gap: isMobile ? 18 : 48,
          alignItems: 'center',
          padding: isMobile ? '32px 0 0' : '56px 0 8px',
        }}
      >
        <div>
          <h2 style={{ fontSize: isMobile ? 20 : 24, fontWeight: 700, letterSpacing: '-0.01em', margin: 0 }}>Brands book you at your price</h2>
          <p style={{ fontSize: 15, lineHeight: 1.55, color: theme.textMuted, margin: '10px 0 0' }}>
            They pay upfront, into your own Stripe account, before you start. OpenPartner takes no cut of your price.
          </p>
          <a
            href={`${SITE}/creators/storefronts`}
            target="_blank"
            rel="noreferrer noopener"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 4, marginTop: 14, fontSize: 14, fontWeight: 500, color: theme.accentText, textDecoration: 'none' }}
          >
            See how storefronts work
            <ArrowUpRight size={15} />
          </a>
        </div>
        <img
          src="/claim/storefront-booking.png"
          width={988}
          height={706}
          alt="A booking request on a creator's storefront: a brand asks for a dedicated review video at $1,800, with Accept and Decline buttons."
          style={{ width: '100%', height: 'auto', borderRadius: theme.radiusLg, border: `1px solid ${theme.border}`, boxShadow: theme.shadowRaised }}
        />
      </section>

      {/* What we hold: theirs to read before deciding. */}
      <section
        style={{
          marginTop: isMobile ? 28 : 40,
          paddingTop: 16,
          borderTop: `1px solid ${theme.borderSubtle}`,
          fontSize: 12,
          color: theme.textMuted,
          lineHeight: 1.6,
          maxWidth: 760,
        }}
      >
        <div style={{ fontWeight: 600, marginBottom: 4 }}>What we hold</div>
        We listed {p.creator.name ?? 'you'} from your public{' '}
        {p.creator.platforms.map((pl) => PLATFORM_LABEL[pl.platform] ?? pl.platform).join(' and ')} profile
        {p.creator.platforms.length === 1 ? '' : 's'}
        {p.creator.email && p.creator.emailFoundOn ? <>, and got {p.creator.email} from {p.creator.emailFoundOn}</> : null}.
        {signals.length > 0 && (
          <>
            {' '}
            {shown ? 'We show brands that you take partnerships, from' : 'Brands don’t see this listing. It notes that you take partnerships, from'}{' '}
            {signals.map((s, i) => (
              <span key={s.kind}>
                {i > 0 && (i === signals.length - 1 ? ' and ' : ', ')}
                {creatorSignalLabel(s)}
                {s.evidence && (
                  <>
                    {' '}(
                    <a href={s.evidence} target="_blank" rel="noreferrer noopener" style={{ color: theme.textMuted }}>
                      {shortUrl(s.evidence)}
                    </a>
                    )
                  </>
                )}
              </span>
            ))}
            .
          </>
        )}{' '}
        Claiming moves it into your own account; anything you don&rsquo;t want, you can change there. The email we sent has a link to remove
        the listing instead.{' '}
        <a href={`${SITE}/privacy#indexed-creators`} target="_blank" rel="noreferrer noopener" style={{ color: theme.textMuted }}>
          Privacy policy
        </a>
      </section>
    </Frame>
  );
}

/** The page around it: our name, linking to the site, and a way to sign in. */
function Frame({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  return (
    <div
      style={{
        minHeight: '100vh',
        background: `radial-gradient(1200px 700px at 30% -10%, ${theme.accentSoftA40}, transparent), ${theme.bg}`,
      }}
    >
      <div
        style={{
          maxWidth: 1080,
          minHeight: '100vh',
          margin: '0 auto',
          padding: isMobile ? '0 16px 32px' : '0 32px 48px',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '18px 0' }}>
          <a href={`${SITE}/creators`} target="_blank" rel="noreferrer noopener" style={{ display: 'flex', alignItems: 'center', gap: 10, color: theme.text, textDecoration: 'none' }}>
            {/* The name beside it says what the mark is. */}
            <img src="/logo-mark-green.svg" alt="" width={26} height={26} style={{ display: 'block' }} />
            <span style={{ fontSize: 17, fontWeight: 700, letterSpacing: '-0.01em' }}>OpenPartner</span>
          </a>
          <Button variant="ghost" size="sm" onClick={() => navigate('/creator/login')}>
            Sign in
          </Button>
        </header>
        {children}
        <footer style={{ marginTop: 'auto', paddingTop: 32, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px 16px', fontSize: 12, color: theme.textMuted }}>
          <a href={SITE} target="_blank" rel="noreferrer noopener" style={{ color: theme.textMuted }}>
            openpartner.dev
          </a>
          <ThemeToggle />
          <CookieSettingsButton />
        </footer>
      </div>
    </div>
  );
}

/** Their listing, laid out the way a brand would see their card. */
function ProfileCard({ creator, shown, signals }: { creator: ClaimPreview['creator']; shown: boolean; signals: PartnershipSignal[] }) {
  // The topics brands search by, as on their card; the broad categories
  // where there are none.
  const tags = (creator.topics?.length ? creator.topics : (creator.categories ?? [])).slice(0, 6);
  return (
    <div
      style={{
        background: theme.surface,
        border: `1px solid ${theme.border}`,
        borderRadius: theme.radiusLg,
        boxShadow: theme.shadowRaised,
        padding: 22,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 16 }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: theme.textMuted, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Your profile</span>
        {!shown && (
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
              fontSize: 12,
              color: theme.textMuted,
              background: theme.surface2,
              borderRadius: 999,
              padding: '3px 9px',
            }}
          >
            <EyeOff size={12} />
            Hidden from brands
          </span>
        )}
      </div>
      <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
        {creator.avatarUrl ? (
          <img src={creator.avatarUrl} alt="" style={{ width: 60, height: 60, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }} />
        ) : (
          <div
            style={{
              width: 60,
              height: 60,
              borderRadius: '50%',
              background: theme.surface2,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
            }}
          >
            <UserRound size={28} strokeWidth={1.5} style={{ color: theme.textMuted }} />
          </div>
        )}
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 18, fontWeight: 600, overflowWrap: 'anywhere' }}>{creator.name ?? 'You'}</div>
          {creator.country && <div style={{ fontSize: 12, color: theme.textDim, marginTop: 2 }}>{countryName(creator.country)}</div>}
          {creator.platforms.length > 0 && (
            <ChannelCounts style={{ marginTop: 6 }}>
              {creator.platforms.map((pl) => (
                <ChannelCount
                  key={pl.platform}
                  platform={pl.platform}
                  followers={pl.followerCount}
                  href={pl.profileUrl}
                  engagementRate={pl.engagementRate}
                  engagementPosts={pl.engagementPosts}
                  readFromProfile
                />
              ))}
            </ChannelCounts>
          )}
        </div>
      </div>
      {creator.headline && (
        <p
          style={{
            fontSize: 14,
            lineHeight: 1.5,
            color: theme.textMuted,
            margin: '14px 0 0',
            display: '-webkit-box',
            WebkitLineClamp: 4,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
          }}
        >
          {creator.headline}
        </p>
      )}
      {(signals.length > 0 || tags.length > 0) && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 14 }}>
          {signals.map((s) => (
            <span key={s.kind} style={{ fontSize: 12, color: theme.accentText, background: theme.accentA15, borderRadius: 999, padding: '3px 9px' }}>
              {brandSignalLabel(s)}
            </span>
          ))}
          {tags.map((t) => (
            <span key={t} style={{ fontSize: 12, color: theme.textMuted, background: theme.surface2, borderRadius: 999, padding: '3px 9px' }}>
              {t}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function Tile({ icon, title, link, children }: { icon: ReactNode; title: string; link?: { href: string; label: string }; children: ReactNode }) {
  return (
    <div style={{ background: theme.surface, border: `1px solid ${theme.border}`, borderRadius: theme.radiusLg, padding: 20 }}>
      <div
        style={{
          width: 40,
          height: 40,
          borderRadius: 12,
          background: theme.accentA15,
          color: theme.accentText,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {icon}
      </div>
      <div style={{ fontSize: 16, fontWeight: 600, marginTop: 14 }}>{title}</div>
      <p style={{ fontSize: 14, lineHeight: 1.5, color: theme.textMuted, margin: '6px 0 0' }}>{children}</p>
      {link && (
        <a
          href={link.href}
          target="_blank"
          rel="noreferrer noopener"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 4, marginTop: 12, fontSize: 13, fontWeight: 500, color: theme.accentText, textDecoration: 'none' }}
        >
          {link.label}
          <ArrowUpRight size={14} />
        </a>
      )}
    </div>
  );
}
