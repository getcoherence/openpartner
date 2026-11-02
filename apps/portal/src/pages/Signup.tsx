import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { ApiError } from '../api.js';
import { alpha, softText, theme } from '../theme.js';
import { AuthFrame, ReviewNotice, SignupTabs } from './auth/Shared.js';
import { CountryField, countryErrorMessage } from '../lib/CountryField.js';
import {
  GoogleButton,
  googleStartHref,
  MIN_PASSWORD_LENGTH,
  OrDivider,
  PasswordInput,
  SIGNUP_PLAN_KEY,
  useAuthProviders,
} from './auth/PasswordAuth.js';

type SignupPlan = 'flex' | 'revshare' | 'enterprise';
const PLAN_LABELS: Record<SignupPlan, { name: string; tagline: string }> = {
  flex: { name: 'Flex', tagline: '$49/mo + 1.5% of attributed GMV · 14-day free trial' },
  revshare: { name: 'Revshare', tagline: '3% of attributed GMV, no monthly · 14-day free trial' },
  enterprise: { name: 'Enterprise', tagline: 'Custom pricing — our team will reach out' },
};
function isPlan(s: string | null): s is SignupPlan {
  return s === 'flex' || s === 'revshare' || s === 'enterprise';
}

interface SignupResult {
  ok: true;
  tenant: { id: string; slug: string };
  mailDelivered?: boolean;
  mailError?: string;
}

export function SignupPage() {
  const [params] = useSearchParams();
  const planParam = params.get('plan');
  const plan: SignupPlan | null = isPlan(planParam) ? planParam : null;
  // A partner link straight to /signup arrives with the click as ?cref=.
  // Sent with the signup so OpenPartner's own program credits the partner;
  // one through openpartner.dev rides the op_ref cookie instead.
  const cref = params.get('cref');
  const [slug, setSlug] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [adminEmail, setAdminEmail] = useState('');
  const [adminName, setAdminName] = useState('');
  const [password, setPassword] = useState('');
  const providers = useAuthProviders();
  const [country, setCountry] = useState('');
  const [outsideOccupiedRegions, setOutsideOccupiedRegions] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<SignupResult | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      // Public signup — explicit fetch so we don't pick up a stale tenant
      // prefix from currentTenantSlug() if the user navigated here from
      // somewhere weird. /signup is mounted before tenantMiddleware on
      // the API side anyway.
      const res = await fetch('/api/signup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          slug: slug.trim().toLowerCase(),
          displayName: displayName.trim(),
          adminEmail: adminEmail.trim().toLowerCase(),
          adminName: adminName.trim(),
          // Starts working once the activation link is redeemed.
          password,
          country,
          ...(country === 'UA' ? { outsideOccupiedRegions } : {}),
          // Enterprise is sales-led: the API refuses self-declared
          // enterprise (it would bypass the plan-required gate), so the
          // CTA only records intent visually; ops set the plan on close.
          ...(plan && plan !== 'enterprise' ? { plan } : {}),
          ...(cref ? { cref } : {}),
        }),
      });
      const data = (await res.json()) as Record<string, unknown>;
      if (!res.ok) {
        throw new ApiError(res.status, String(data.error ?? `${res.status}`), data);
      }
      setResult(data as unknown as SignupResult);
    } catch (e) {
      const code = e instanceof ApiError ? String(e.message) : 'unknown_error';
      setErr(friendlyError(code));
    } finally {
      setBusy(false);
    }
  }

  if (result) {
    return (
      <AuthFrame title="Confirm your email" subtitle={`We just emailed ${adminEmail} a link to confirm it’s yours.`}>
        <div style={{ background: theme.successSoft, border: `1px solid ${alpha(theme.success, 0.333)}`, padding: 14, borderRadius: theme.radiusSm, fontSize: 13, color: theme.success }}>
          <div style={{ fontWeight: 500, marginBottom: 6 }}>Account created.</div>
          <div style={{ color: softText(theme.success) }}>
            Your slug is <code>{result.tenant.slug}</code>. Click the link (it&rsquo;s good for 15 minutes) and you&rsquo;re in;
            after that, sign in with your email and password.
          </div>
        </div>
        {result.mailDelivered === false && (
          <div style={{ marginTop: 12, color: theme.danger, fontSize: 13 }}>
            Mail send failed: {result.mailError ?? 'unknown'}. Contact support to retry.
          </div>
        )}
      </AuthFrame>
    );
  }

  return (
    <AuthFrame title="Sign up as a brand" subtitle="Create your brand account.">
      <SignupTabs active="brand" />
      {plan && (
        <div
          style={{
            background: `${theme.accentA10}`,
            border: `1px solid ${theme.accentA55}`,
            borderRadius: theme.radiusSm,
            padding: '10px 12px',
            marginBottom: 14,
          }}
        >
          <div style={{ fontSize: 12, color: theme.accentText, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase', marginBottom: 2 }}>
            Plan: {PLAN_LABELS[plan].name}
          </div>
          <div style={{ fontSize: 12, color: theme.textMuted }}>
            {PLAN_LABELS[plan].tagline}
          </div>
        </div>
      )}
      <ReviewNotice>New brands are reviewed before going live. You can set up your programs in the meantime.</ReviewNotice>
      {providers.googleStartUrl && (
        <>
          {/* Google signs the person in first; with no brand yet,
              /workspaces sends them to /brands/new, which picks the plan
              chosen here back up. */}
          <span
            onClickCapture={() => {
              try {
                if (plan && plan !== 'enterprise') sessionStorage.setItem(SIGNUP_PLAN_KEY, plan);
              } catch {
                /* storage blocked — the plan is just not preselected */
              }
            }}
          >
            <GoogleButton href={googleStartHref(providers.googleStartUrl, 'account')}>Sign up with Google</GoogleButton>
          </span>
          <OrDivider />
        </>
      )}
      <form onSubmit={submit}>
        <Field label="Brand name" hint="What partners see — e.g. Acme.">
          <input
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="Acme"
            required
            style={inputStyle}
          />
        </Field>
        <Field label="URL slug" hint="Lowercase letters, numbers, hyphens. Becomes app.openpartner.dev/t/<slug>/.">
          <input
            value={slug}
            onChange={(e) => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
            placeholder="acme"
            pattern="[a-z0-9\-]{3,40}"
            minLength={3}
            maxLength={40}
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
          <input
            name="name"
            autoComplete="name"
            value={adminName}
            onChange={(e) => setAdminName(e.target.value)}
            placeholder="Ada Lovelace"
            required
            style={inputStyle}
          />
        </Field>
        <Field label="Your email" hint="We'll send a link here to confirm it's yours.">
          <input
            type="email"
            name="email"
            autoComplete="email"
            value={adminEmail}
            onChange={(e) => setAdminEmail(e.target.value)}
            placeholder="ada@example.com"
            required
            style={inputStyle}
          />
        </Field>
        <Field label="Password" hint={`At least ${MIN_PASSWORD_LENGTH} characters. A few unrelated words works well.`}>
          <PasswordInput value={password} onChange={setPassword} autoComplete="new-password" style={inputStyle} />
        </Field>
        {err && <div style={{ color: theme.danger, fontSize: 13, marginTop: 4, marginBottom: 8 }}>{err}</div>}
        <button type="submit" disabled={busy} style={primaryBtnStyle(busy)}>
          {busy ? 'Creating brand…' : 'Create brand account'}
        </button>
        <div style={{ marginTop: 12, fontSize: 12, color: theme.textDim, textAlign: 'center' }}>
          Already have a program? <Link to="/signin" style={{ color: theme.accentText }}>Sign in</Link>
        </div>
      </form>
    </AuthFrame>
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

function friendlyError(code: string): string {
  const country = countryErrorMessage(code);
  if (country) return country;
  if (code.includes('slug_taken')) return 'That slug is already taken. Pick another.';
  if (code.includes('slug_reserved')) return 'That slug is reserved. Try a different one.';
  if (code.includes('invalid_body'))
    return `Some fields look invalid — check the slug format, the email, and that the password has at least ${MIN_PASSWORD_LENGTH} characters.`;
  if (code.includes('signup_not_available')) return 'Public signup is disabled on this deployment.';
  return 'Something went wrong. Try again or contact support.';
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

function primaryBtnStyle(disabled: boolean): React.CSSProperties {
  return {
    marginTop: 6,
    width: '100%',
    padding: '10px 14px',
    background: theme.accent,
    color: theme.accentInk,
    border: 'none',
    borderRadius: theme.radiusSm,
    fontSize: 14,
    fontWeight: 600,
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.5 : 1,
  };
}
