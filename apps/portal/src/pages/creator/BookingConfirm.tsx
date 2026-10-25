/**
 * /booking/confirm?token=… — where a public storefront request's emailed
 * link lands (the Network's docs/creator-storefront.md §8.4). Requests reach
 * a creator from a brand, so the requester continues as one:
 *
 *   - signed in as a brand admin: send it as that brand (the claim page);
 *   - signed in to OpenPartner but no workspace picked: pick one (/workspaces);
 *   - the address already has a brand: sign in, then the claim page;
 *   - otherwise: name the brand here and it's created for the address the
 *     link was sent to (routes/booking-claims.ts), signed in, with the
 *     request sent and the conversation open.
 *
 * Nothing happens without a click, so mail scanners that prefetch links
 * can't act for the requester.
 */
import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { useMutation, useQuery } from '@tanstack/react-query';
import { MessagesSquare } from 'lucide-react';
import { Button, Card } from '../../ui.js';
import { theme } from '../../theme.js';
import { PUBLIC_SITE_URL, publicStorefrontUrl } from '../../lib/public-site.js';
import { CountryField, countryErrorMessage } from '../../lib/CountryField.js';
import { withNext } from '../../lib/signin-next.js';

interface ClaimPreview {
  creator: { id: string; name: string; handle: string | null; avatarUrl: string | null };
  packageTitle: string | null;
  contactName: string;
  company: string | null;
  brief: string;
  email: string;
  accountExists: boolean;
  suggested: { displayName: string; slug: string };
}

interface SessionHome {
  home: string | null;
  kind?: string;
}

class ClaimError extends Error {
  constructor(public status: number, public code: string) {
    super(code);
  }
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new ClaimError(res.status, String(data.error ?? res.status));
  return data as T;
}

const LINK_ERRORS: Record<string, string> = {
  invalid_or_used: 'This link has already been used, or it isn’t valid.',
  expired: 'This link has expired. Send your request again from the creator’s page.',
  creator_unavailable: 'This creator isn’t taking requests right now.',
  network_not_configured: 'Requests can’t be sent right now. Try again later.',
  network_unavailable: 'Something went wrong on our side. Try again in a moment.',
};

function signupError(code: string): string {
  const country = countryErrorMessage(code);
  if (country) return country;
  if (code === 'slug_taken') return 'That workspace address is taken. Try another.';
  if (code === 'slug_reserved') return 'That workspace address is reserved. Try another.';
  if (code === 'account_exists') return 'This address already has an OpenPartner account. Sign in instead.';
  if (code === 'signup_unavailable') return 'We can’t create an account for this address.';
  if (code === 'invalid_body') return 'Check the fields and try again.';
  return LINK_ERRORS[code] ?? 'Something went wrong. Try again in a moment.';
}

export function BookingConfirmPage() {
  const nav = useNavigate();
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const claimPath = `/admin/network/claim?token=${encodeURIComponent(token)}`;

  const preview = useQuery({
    queryKey: ['booking-claim-preview', token],
    queryFn: () => post<ClaimPreview>('/booking-claims/preview', { token }),
    enabled: !!token,
    retry: false,
  });
  const session = useQuery({
    queryKey: ['session-home'],
    queryFn: async () => (await fetch('/api/session/home', { credentials: 'include' }).then((r) => r.json())) as SessionHome,
    retry: false,
  });

  const p = preview.data;
  const brandHome = session.data?.kind === 'admin' && session.data.home?.startsWith('/t/') ? session.data.home : null;
  const platformOnly = session.data?.kind === 'platform';
  const linkError =
    preview.error instanceof ClaimError
      ? LINK_ERRORS[preview.error.code] ?? LINK_ERRORS.network_unavailable
      : preview.error
        ? LINK_ERRORS.network_unavailable
        : null;

  return (
    <div style={{ minHeight: '100vh', background: theme.bg, padding: '64px 20px' }}>
      <div style={{ maxWidth: 520, margin: '0 auto' }}>
        <Card>
          {!token || linkError ? (
            <>
              <div style={{ fontSize: 17, fontWeight: 600 }}>Your request</div>
              <div style={{ marginTop: 12, fontSize: 14, color: theme.danger, background: theme.dangerSoft, borderRadius: theme.radiusSm, padding: '10px 12px' }}>
                {linkError ?? 'This link is missing its request.'}
              </div>
            </>
          ) : !p || session.isLoading ? (
            <div style={{ fontSize: 14, color: theme.textMuted }}>Loading…</div>
          ) : (
            <>
              <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start' }}>
                {p.creator.avatarUrl ? (
                  <img src={p.creator.avatarUrl} alt="" style={{ width: 44, height: 44, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }} />
                ) : (
                  <MessagesSquare size={28} strokeWidth={1.5} style={{ color: theme.accentText, flexShrink: 0 }} />
                )}
                <div>
                  <div style={{ fontSize: 17, fontWeight: 600 }}>Send your request to {p.creator.name}</div>
                  <div style={{ fontSize: 14, color: theme.textMuted, marginTop: 6, lineHeight: 1.5 }}>
                    {p.packageTitle ? <>For <strong style={{ color: theme.text }}>{p.packageTitle}</strong>. </> : null}
                    You&rsquo;ll talk it through with {p.creator.name.split(' ')[0]} on OpenPartner, and pay through the booking once you
                    agree, straight to their Stripe account. Neither of you sees the other&rsquo;s email address.
                  </div>
                </div>
              </div>
              <blockquote
                style={{
                  borderLeft: `3px solid ${theme.border}`,
                  margin: '16px 0 0',
                  padding: '2px 0 2px 12px',
                  fontSize: 13,
                  color: theme.textMuted,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                }}
              >
                {p.brief}
              </blockquote>

              <div style={{ marginTop: 20 }}>
                {brandHome ? (
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <Button onClick={() => nav(`${brandHome.replace(/\/$/, '')}${claimPath}`)}>Send it as your brand</Button>
                    <Button variant="secondary" onClick={() => nav(withNext('/workspaces', claimPath))}>
                      Pick another brand
                    </Button>
                  </div>
                ) : platformOnly ? (
                  <Button onClick={() => nav(withNext('/workspaces', claimPath))}>Choose your brand</Button>
                ) : p.accountExists ? (
                  <>
                    <div style={{ fontSize: 14, color: theme.textMuted, marginBottom: 10 }}>
                      {p.email} already has an OpenPartner account. Sign in and your request goes out from your brand.
                    </div>
                    <Button onClick={() => nav(withNext('/signin', claimPath), { state: { email: p.email } })}>Sign in to send it</Button>
                  </>
                ) : (
                  <CreateBrand token={token} preview={p} />
                )}
              </div>
              {p.creator.handle && (
                <div style={{ marginTop: 18, fontSize: 13 }}>
                  <a href={publicStorefrontUrl(p.creator.handle)} style={{ color: theme.accentText }}>
                    Back to {p.creator.name}&rsquo;s page
                  </a>
                </div>
              )}
            </>
          )}
        </Card>
      </div>
    </div>
  );
}

function CreateBrand({ token, preview }: { token: string; preview: ClaimPreview }) {
  const [displayName, setDisplayName] = useState(preview.suggested.displayName);
  const [slug, setSlug] = useState(preview.suggested.slug);
  const [adminName, setAdminName] = useState(preview.contactName);
  const [country, setCountry] = useState('');
  const [outsideOccupiedRegions, setOutsideOccupiedRegions] = useState(false);
  const create = useMutation({
    mutationFn: () =>
      post<{ tenant: { slug: string }; conversationId: string | null }>('/booking-claims/signup', {
        token,
        displayName: displayName.trim(),
        slug: slug.trim(),
        adminName: adminName.trim(),
        country,
        ...(country === 'UA' ? { outsideOccupiedRegions } : {}),
      }),
    // A full load: the app reads the new session from scratch.
    onSuccess: (r) =>
      window.location.assign(
        r.conversationId
          ? `/t/${r.tenant.slug}/admin/network/messages/${r.conversationId}`
          : `/t/${r.tenant.slug}/admin/network/claim?token=${encodeURIComponent(token)}`,
      ),
  });
  const ok = !!displayName.trim() && /^[a-z0-9-]{3,30}$/.test(slug) && !!adminName.trim() && !!country && !create.isPending;
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (ok) create.mutate();
      }}
    >
      <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 4 }}>Create your brand account</div>
      <div style={{ fontSize: 13, color: theme.textMuted, marginBottom: 14, lineHeight: 1.5 }}>
        For <strong style={{ color: theme.text }}>{preview.email}</strong>, the address this link was sent to. No password needed: you&rsquo;re
        signed in straight away, and can add one later.
      </div>
      <Field label="Brand name">
        <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Acme" required style={inputStyle} />
      </Field>
      <Field label="Workspace address" hint="Lowercase letters, numbers, hyphens. Becomes app.openpartner.dev/t/<address>/.">
        <input
          value={slug}
          onChange={(e) => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
          minLength={3}
          maxLength={30}
          required
          style={{ ...inputStyle, fontFamily: theme.fontMono }}
        />
      </Field>
      <Field label="Where is your business based?">
        <CountryField
          value={country}
          onChange={setCountry}
          outsideOccupiedRegions={outsideOccupiedRegions}
          onOutsideOccupiedRegionsChange={setOutsideOccupiedRegions}
          selectStyle={inputStyle}
        />
      </Field>
      <Field label="Your name">
        <input value={adminName} onChange={(e) => setAdminName(e.target.value)} autoComplete="name" required style={inputStyle} />
      </Field>
      {create.error && (
        <div style={{ color: theme.danger, fontSize: 13, marginBottom: 8 }}>
          {signupError(create.error instanceof ClaimError ? create.error.code : 'unknown')}
        </div>
      )}
      <Button type="submit" disabled={!ok}>
        {create.isPending ? 'Creating your brand…' : `Create brand and send to ${preview.creator.name.split(' ')[0]}`}
      </Button>
      <div style={{ fontSize: 12, color: theme.textDim, marginTop: 10, lineHeight: 1.5 }}>
        By continuing you agree to the{' '}
        <a href={`${PUBLIC_SITE_URL}/terms`} target="_blank" rel="noopener noreferrer" style={{ color: theme.accentText }}>
          Terms
        </a>{' '}
        and{' '}
        <a href={`${PUBLIC_SITE_URL}/privacy`} target="_blank" rel="noopener noreferrer" style={{ color: theme.accentText }}>
          Privacy Policy
        </a>
        . New brands are reviewed before they can reach out to other creators; your request goes out now.
      </div>
    </form>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 12, color: theme.textMuted, marginBottom: 4 }}>{label}</div>
      {children}
      {hint && <div style={{ fontSize: 11, color: theme.textDim, marginTop: 4 }}>{hint}</div>}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '10px 12px',
  fontSize: 14,
  background: theme.surface2,
  border: `1px solid ${theme.border}`,
  borderRadius: theme.radiusSm,
  color: theme.text,
};
