import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { theme } from '../theme.js';
import { Logo } from './auth/Shared.js';
import { CountryField, countryErrorMessage } from '../lib/CountryField.js';
import { Notice, SIGNUP_PLAN_KEY, WORK_EMAIL_NEEDED } from './auth/PasswordAuth.js';

/**
 * Authenticated add-brand flow (§13). Reached from the identity switcher's
 * "Create a new brand" action. Unlike the public /signup form this:
 *   - reuses the platform-session email for the new brand's first Admin
 *     (no re-entry, so the brand can't be orphaned from the switcher);
 *   - REQUIRES a plan choice — each brand is its own independently-billed
 *     tenant, and partner onboarding stays locked until checkout completes;
 *   - drops the user straight into the new brand's Billing page to finish
 *     Stripe Checkout.
 *
 * A free mail address that can't open a brand (GET /me/workspaces says so,
 * as "Sign up with Google" with Gmail does) gets the reason, not the form.
 */

type Plan = 'flex' | 'revshare';

const PLANS: Array<{ key: Plan; name: string; tagline: string; detail: string }> = [
  {
    key: 'flex',
    name: 'Flex',
    tagline: '$49/mo + 1.5% of attributed GMV',
    detail: 'Predictable monthly base. 14-day free trial, then checkout required.',
  },
  {
    key: 'revshare',
    name: 'RevShare',
    tagline: '3% of attributed GMV · no monthly fee',
    detail:
      'A $0/mo metered subscription — you still check out, and pay 3% of this brand’s attributed revenue as it earns.',
  },
];

function signupPlan(): Plan | null {
  try {
    const stored = sessionStorage.getItem(SIGNUP_PLAN_KEY);
    return stored === 'flex' || stored === 'revshare' ? stored : null;
  } catch {
    return null;
  }
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30);
}

export function AddBrandPage() {
  const nav = useNavigate();
  const [displayName, setDisplayName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  // Preselected when "Sign up with Google" on /signup carried a plan here.
  const [plan, setPlan] = useState<Plan | null>(signupPlan);
  const [country, setCountry] = useState('');
  const [outsideOccupiedRegions, setOutsideOccupiedRegions] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const effectiveSlug = slugTouched ? slug : slugify(displayName);
  const identity = useQuery({
    queryKey: ['add-brand-identity'],
    queryFn: async () => {
      const r = await fetch('/api/me/workspaces', { credentials: 'include' });
      if (!r.ok) return null;
      return (await r.json()) as { email: string; workEmailRequired?: boolean };
    },
    retry: false,
  });
  const workEmailRequired = identity.data?.workEmailRequired === true;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!plan) return;
    setBusy(true);
    setErr(null);
    try {
      // Platform-level endpoints — no tenant prefix, cookie-authenticated.
      const res = await fetch('/api/me/brands', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          slug: effectiveSlug,
          displayName: displayName.trim(),
          plan,
          country,
          ...(country === 'UA' ? { outsideOccupiedRegions } : {}),
        }),
      });
      const data = (await res.json()) as { ok?: boolean; home?: string; tenant?: { slug: string }; error?: string };
      if (res.status === 401) {
        nav('/signin', { replace: true });
        return;
      }
      if (!res.ok || !data.ok || !data.tenant) throw new Error(data.error ?? `${res.status}`);
      // Enter the new workspace with the existing platform session, then
      // land on Billing so checkout happens while intent is hot.
      const enter = await fetch('/api/workspaces/enter', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ slug: data.tenant.slug }),
      });
      const entered = (await enter.json()) as { ok?: boolean; home?: string; error?: string };
      if (!enter.ok || !entered.ok || !entered.home) throw new Error(entered.error ?? `${enter.status}`);
      try {
        sessionStorage.removeItem(SIGNUP_PLAN_KEY);
      } catch {
        /* storage blocked */
      }
      nav(`${entered.home}admin/billing`, { replace: true });
    } catch (e) {
      setErr(friendlyError(e instanceof Error ? e.message : 'unknown_error'));
      setBusy(false);
    }
  }

  // Nothing until the address is known, so a refused one never sees the form.
  if (identity.isLoading) return <Frame>{null}</Frame>;
  if (workEmailRequired) {
    return (
      <Frame>
        <Notice tone="danger">
          {WORK_EMAIL_NEEDED} You’re signed in as {identity.data!.email}.
        </Notice>
        <Link to="/signup" style={{ color: theme.accentText, fontSize: 14 }}>
          Sign up with a work email
        </Link>
      </Frame>
    );
  }

  return (
    <Frame>
      <p style={{ color: theme.textMuted, fontSize: 14, marginTop: 0, marginBottom: 20, lineHeight: 1.5 }}>
        Each brand is a fully isolated program with its <strong>own plan, billed separately</strong>.
        It shares your sign-in and shows up in the brand switcher.
      </p>
      {err && <div style={{ color: theme.danger, fontSize: 13, marginBottom: 12 }}>{err}</div>}
      <form onSubmit={submit}>
        <label style={labelStyle}>Brand name</label>
        <input
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          placeholder="Acme Coffee"
          required
          autoFocus
          style={inputStyle}
        />
        <label style={labelStyle}>Workspace URL</label>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ color: theme.textDim, fontSize: 13, fontFamily: theme.fontMono }}>/t/</span>
          <input
            value={effectiveSlug}
            onChange={(e) => {
              setSlugTouched(true);
              setSlug(slugify(e.target.value));
            }}
            placeholder="acme-coffee"
            required
            minLength={3}
            style={{ ...inputStyle, fontFamily: theme.fontMono, marginBottom: 0, flex: 1 }}
          />
        </div>
        <label style={{ ...labelStyle, marginTop: 18 }} htmlFor="add-brand-country">
          Where is this business based?
        </label>
        <CountryField
          id="add-brand-country"
          value={country}
          onChange={setCountry}
          outsideOccupiedRegions={outsideOccupiedRegions}
          onOutsideOccupiedRegionsChange={setOutsideOccupiedRegions}
          selectStyle={{ ...inputStyle, marginBottom: 0 }}
        />
        <label style={{ ...labelStyle, marginTop: 18 }}>Plan for this brand</label>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {PLANS.map((p) => {
            const active = plan === p.key;
            return (
              <button
                key={p.key}
                type="button"
                onClick={() => setPlan(p.key)}
                style={{
                  textAlign: 'left',
                  background: active ? `${theme.accentA15}` : theme.surface,
                  border: `1px solid ${active ? theme.accent : theme.borderSubtle}`,
                  borderRadius: theme.radiusSm,
                  padding: '12px 14px',
                  color: theme.text,
                  cursor: 'pointer',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
                  <span style={{ fontWeight: 600, fontSize: 14 }}>{p.name}</span>
                  <span style={{ color: active ? theme.accentText : theme.textMuted, fontSize: 13 }}>{p.tagline}</span>
                </div>
                <div style={{ color: theme.textMuted, fontSize: 12, marginTop: 4, lineHeight: 1.5 }}>{p.detail}</div>
              </button>
            );
          })}
        </div>
        <button
          type="submit"
          disabled={busy || !plan || !country || !displayName.trim() || effectiveSlug.length < 3}
          style={{
            marginTop: 18,
            width: '100%',
            padding: '10px 14px',
            background: theme.accent,
            color: theme.accentInk,
            border: 'none',
            borderRadius: theme.radiusSm,
            fontSize: 14,
            fontWeight: 600,
            cursor: busy ? 'wait' : 'pointer',
            opacity: busy || !plan || !country || !displayName.trim() || effectiveSlug.length < 3 ? 0.5 : 1,
          }}
        >
          {busy ? 'Creating…' : 'Create brand & continue to billing'}
        </button>
      </form>
    </Frame>
  );
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ minHeight: '100vh', background: theme.bg, color: theme.text, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      <div style={{ maxWidth: 460, width: '100%' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 28 }}>
          <Logo />
          <div style={{ fontSize: 16, fontWeight: 600 }}>OpenPartner</div>
        </div>
        <h1 style={{ fontSize: 24, fontWeight: 700, margin: '0 0 6px', letterSpacing: '-0.01em' }}>Create a new brand</h1>
        {children}
      </div>
    </div>
  );
}

function friendlyError(code: string): string {
  const country = countryErrorMessage(code);
  if (country) return country;
  switch (code) {
    case 'slug_taken':
    case 'slug_reserved':
      return 'That workspace URL is taken — pick another.';
    case 'no_platform_session':
    case 'invalid_or_expired_session':
      return 'Your session expired. Sign in again, then retry.';
    case 'signup_unavailable':
      return 'We can’t create a brand for this account. Contact support if you think that’s wrong.';
    case 'work_email_required':
      return WORK_EMAIL_NEEDED;
    default:
      return `Could not create the brand (${code}).`;
  }
}

const labelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: 12,
  fontWeight: 600,
  color: theme.textMuted,
  margin: '0 0 6px',
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
};

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '10px 12px',
  fontSize: 14,
  background: theme.surface2,
  border: `1px solid ${theme.border}`,
  borderRadius: theme.radiusSm,
  color: theme.text,
  marginBottom: 14,
};
