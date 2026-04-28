import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError } from '../api.js';
import { theme } from '../theme.js';
import { AuthFrame } from './auth/Shared.js';

interface SignupResult {
  ok: true;
  tenant: { id: string; slug: string };
  mailDelivered?: boolean;
  mailError?: string;
}

export function SignupPage() {
  const [slug, setSlug] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [adminEmail, setAdminEmail] = useState('');
  const [adminName, setAdminName] = useState('');
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
      <AuthFrame title="Check your inbox" subtitle={`We just emailed ${adminEmail} a sign-in link.`}>
        <div style={{ background: theme.successSoft, border: `1px solid ${theme.success}55`, padding: 14, borderRadius: theme.radiusSm, fontSize: 13, color: theme.success }}>
          <div style={{ fontWeight: 500, marginBottom: 6 }}>Program created.</div>
          <div style={{ color: `${theme.success}cc` }}>
            Your slug is <code>{result.tenant.slug}</code>. The activation link is good for 15 minutes.
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
    <AuthFrame title="Create your program" subtitle="One minute to provision. We'll email you a sign-in link.">
      <form onSubmit={submit}>
        <Field label="Program name" hint="What partners see in your portal — e.g. Acme Affiliates.">
          <input
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="Acme Affiliates"
            required
            style={inputStyle}
          />
        </Field>
        <Field label="URL slug" hint="Lowercase letters, numbers, hyphens. Becomes app.openpartner.dev/t/<slug>/.">
          <input
            value={slug}
            onChange={(e) => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
            placeholder="acme"
            pattern="[a-z0-9-]{3,40}"
            minLength={3}
            maxLength={40}
            required
            style={{ ...inputStyle, fontFamily: theme.fontMono }}
          />
        </Field>
        <Field label="Your name">
          <input
            value={adminName}
            onChange={(e) => setAdminName(e.target.value)}
            placeholder="Ada Lovelace"
            required
            style={inputStyle}
          />
        </Field>
        <Field label="Your email" hint="We'll send the activation link here.">
          <input
            type="email"
            value={adminEmail}
            onChange={(e) => setAdminEmail(e.target.value)}
            placeholder="ada@example.com"
            required
            style={inputStyle}
          />
        </Field>
        {err && <div style={{ color: theme.danger, fontSize: 13, marginTop: 4, marginBottom: 8 }}>{err}</div>}
        <button type="submit" disabled={busy} style={primaryBtnStyle(busy)}>
          {busy ? 'Creating…' : 'Create program'}
        </button>
        <div style={{ marginTop: 12, fontSize: 12, color: theme.textDim, textAlign: 'center' }}>
          Already have a program? <Link to="/" style={{ color: theme.accent }}>Back to landing</Link>
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
  if (code.includes('slug_taken')) return 'That slug is already taken. Pick another.';
  if (code.includes('slug_reserved')) return 'That slug is reserved. Try a different one.';
  if (code.includes('invalid_body')) return 'Some fields look invalid — check the slug format and email.';
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
