import { useState } from 'react';
import { Mail, User } from 'lucide-react';
import { ApiError, api } from '../api.js';
import { theme } from '../theme.js';
import { AuthFrame } from './auth/Shared.js';
import { usePublicBrand } from '../lib/useBrand.js';

/**
 * Public "become a partner" page — the hosted front-end for
 * POST /partner-signup. Tenant-scoped: on a white-label custom domain it
 * lives at /join with the tenant's branding; path-based tenants get
 * /t/<slug>/join. This signs partners up for THIS brand's program only —
 * it is not the platform-level Network creator signup (which white-label
 * portals deliberately don't have).
 *
 * Post-submit states mirror the API: auto-approve sends a sign-in link
 * right away; require-review acknowledges the application; the endpoint
 * is deliberately non-enumerating (already-registered looks like success).
 */

type Phase =
  | { kind: 'form' }
  | { kind: 'sent'; review: boolean }
  | { kind: 'closed' };

export function PartnerJoinPage() {
  const brand = usePublicBrand();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: 'form' });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const r = await api<{ ok: boolean; status: string }>('/partner-signup', {
        method: 'POST',
        body: { name: name.trim(), email: email.trim().toLowerCase() },
      });
      setPhase({ kind: 'sent', review: r.status === 'pending_review' });
    } catch (e) {
      const code = e instanceof ApiError ? String(e.message) : '';
      if (code.includes('signup_disabled') || code.includes('plan_required')) {
        // Either the brand closed signups or its billing is inactive —
        // the partner-facing message is the same.
        setPhase({ kind: 'closed' });
      } else {
        setErr('Something went wrong — try again in a minute.');
      }
    } finally {
      setBusy(false);
    }
  }

  const program = brand.isLoading ? '' : brand.programName;

  if (phase.kind === 'closed') {
    return (
      <AuthFrame title="Signups are closed" subtitle={`${program} isn't accepting new partner applications right now.`}>
        <div style={{ fontSize: 13, color: theme.textMuted, lineHeight: 1.6 }}>
          If you were invited directly, use the link from your invitation email
          {brand.supportEmail ? (
            <>
              {' '}or contact <a href={`mailto:${brand.supportEmail}`} style={{ color: theme.accent }}>{brand.supportEmail}</a>
            </>
          ) : null}
          .
        </div>
      </AuthFrame>
    );
  }

  if (phase.kind === 'sent') {
    return (
      <AuthFrame
        title={phase.review ? 'Application received' : 'Check your inbox'}
        subtitle={
          phase.review
            ? `${program} reviews applications by hand — you'll get an email once you're approved.`
            : `If this email isn't already registered, we sent a sign-in link to ${email}. It's good for 15 minutes.`
        }
      >
        <div style={{ background: theme.successSoft, border: `1px solid ${theme.success}55`, padding: 14, borderRadius: theme.radiusSm, fontSize: 13, color: theme.success }}>
          {phase.review
            ? 'We also emailed you a link to confirm your address — clicking it speeds up review.'
            : 'Click the link to set up your partner dashboard.'}
        </div>
      </AuthFrame>
    );
  }

  return (
    <AuthFrame
      title={`Become a ${program ? `${program} ` : ''}partner`}
      subtitle="Apply to join the partner program. We'll email you a sign-in link."
    >
      <form onSubmit={submit}>
        <div style={{ position: 'relative', marginBottom: 10 }}>
          <User size={15} style={{ position: 'absolute', left: 12, top: 12, color: theme.textDim, pointerEvents: 'none' }} />
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Your name"
            autoComplete="name"
            required
            autoFocus
            style={inputStyle}
          />
        </div>
        <div style={{ position: 'relative' }}>
          <Mail size={15} style={{ position: 'absolute', left: 12, top: 12, color: theme.textDim, pointerEvents: 'none' }} />
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            autoComplete="email"
            required
            style={inputStyle}
          />
        </div>
        {err && <div style={{ color: theme.danger, fontSize: 13, marginTop: 8 }}>{err}</div>}
        <button
          type="submit"
          disabled={busy || !name.trim() || !email.trim()}
          style={{
            marginTop: 14,
            width: '100%',
            padding: '10px 14px',
            background: theme.accent,
            color: theme.accentInk,
            border: 'none',
            borderRadius: theme.radiusSm,
            fontSize: 14,
            fontWeight: 600,
            cursor: busy ? 'wait' : 'pointer',
            opacity: busy || !name.trim() || !email.trim() ? 0.5 : 1,
          }}
        >
          {busy ? 'Submitting…' : 'Apply to join'}
        </button>
      </form>
    </AuthFrame>
  );
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '10px 12px 10px 34px',
  fontSize: 14,
  background: theme.surface2,
  border: `1px solid ${theme.border}`,
  borderRadius: theme.radiusSm,
  color: theme.text,
};
