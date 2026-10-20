import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { alpha, softText, theme } from '../../theme.js';
import { AuthFrame, SignupTabs } from '../auth/Shared.js';
import { CountryField, countryErrorMessage } from '../../lib/CountryField.js';
import { creatorApi, ApiError } from './creator-api.js';

type HandleStatus = 'idle' | 'checking' | 'available' | 'taken';

export function CreatorSignupPage() {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [handle, setHandle] = useState('');
  const [handleStatus, setHandleStatus] = useState<HandleStatus>('idle');
  // Where the creator is based: the Network refuses countries it doesn't
  // serve, and Ukraine also needs the occupied-regions confirmation.
  const [country, setCountry] = useState('');
  const [outsideOccupiedRegions, setOutsideOccupiedRegions] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  // Debounced handle availability lookup. Fires 350ms after the last
  // keystroke; bails if handle is empty (it's optional) or too short.
  // Network 404 / proxy error → silent idle so the form still works
  // when the upstream endpoint isn't deployed yet.
  useEffect(() => {
    if (handle.length < 2) {
      setHandleStatus('idle');
      return;
    }
    setHandleStatus('checking');
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      try {
        const r = await creatorApi<{ available: boolean }>(
          `/creators/handle-available?handle=${encodeURIComponent(handle)}`,
          { signal: ctrl.signal },
        );
        setHandleStatus(r.available ? 'available' : 'taken');
      } catch {
        setHandleStatus('idle');
      }
    }, 350);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [handle]);

  const countryMissing = !country || (country === 'UA' && !outsideOccupiedRegions);
  const cannotSubmit = busy || handleStatus === 'taken' || handleStatus === 'checking' || countryMissing;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (countryMissing) return;
    setBusy(true);
    setErr(null);
    try {
      await creatorApi('/creators/signup', {
        method: 'POST',
        body: {
          email: email.trim(),
          name: name.trim(),
          handle: handle.trim() || undefined,
          country,
          ...(country === 'UA' ? { outsideOccupiedRegions } : {}),
        },
      });
      setSent(true);
    } catch (e) {
      const message = e instanceof ApiError ? e.message : 'Something went wrong.';
      setErr(countryErrorMessage(message) ?? message);
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <AuthFrame title="Check your inbox" subtitle={`We just emailed ${email} a sign-in link.`}>
        <div style={{ background: theme.successSoft, border: `1px solid ${alpha(theme.success, 0.333)}`, padding: 14, borderRadius: theme.radiusSm, fontSize: 13, color: theme.success }}>
          <div style={{ fontWeight: 500, marginBottom: 6 }}>Account created.</div>
          <div style={{ color: softText(theme.success) }}>
            Click the link in the email to finish signing in. It&rsquo;s good for 15 minutes.
          </div>
        </div>
        <div style={{ marginTop: 14, fontSize: 13, color: theme.textMuted, lineHeight: 1.55 }}>
          <strong style={{ color: theme.text }}>Next, so brands can find you:</strong> add a handle, a profile photo,
          a short bio (40+ characters), at least one category, and one social platform. Brands only see complete
          profiles when they search for creators.
        </div>
      </AuthFrame>
    );
  }

  return (
    <AuthFrame title="Sign up as a creator" subtitle="Browse and apply to partner programs across the OpenPartner Network.">
      <SignupTabs active="creator" />
      <form onSubmit={submit}>
        <Field label="Your name">
          <input name="name" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Ada Lovelace" required style={inputStyle} />
        </Field>
        <Field label="Email" hint="We'll send your sign-in link here.">
          <input type="email" name="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="ada@example.com" required style={inputStyle} />
        </Field>
        <Field
          label="Handle (you can add it later)"
          hint={
            handleStatus === 'checking' ? <span style={{ color: theme.textMuted }}>Checking…</span>
            : handleStatus === 'available' ? <span style={{ color: theme.success }}>✓ Available</span>
            : handleStatus === 'taken' ? <span style={{ color: theme.danger }}>✗ Already taken — pick another</span>
            : 'Letters, numbers, hyphens. Used as your default share-link slug.'
          }
        >
          <input
            name="handle"
            autoComplete="username"
            value={handle}
            onChange={(e) => setHandle(e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, ''))}
            placeholder="ada"
            pattern="[a-zA-Z0-9_\-]{2,40}"
            style={{ ...inputStyle, fontFamily: theme.fontMono }}
          />
        </Field>
        <Field label="Where are you based?">
          <CountryField
            id="creator-country"
            value={country}
            onChange={setCountry}
            outsideOccupiedRegions={outsideOccupiedRegions}
            onOutsideOccupiedRegionsChange={setOutsideOccupiedRegions}
            selectStyle={inputStyle}
          />
        </Field>
        {err && <div style={{ color: theme.danger, fontSize: 13, marginTop: 4, marginBottom: 8 }}>{err}</div>}
        <button
          type="submit"
          disabled={cannotSubmit}
          style={primaryBtnStyle(cannotSubmit)}
        >
          {busy ? 'Creating creator…' : 'Become a creator'}
        </button>
        <div style={{ marginTop: 12, fontSize: 12, color: theme.textDim, textAlign: 'center' }}>
          Already have an account? <Link to="/creator/login" style={{ color: theme.accentText }}>Sign in</Link>
        </div>
      </form>
    </AuthFrame>
  );
}

function Field({ label, hint, children }: { label: string; hint?: React.ReactNode; children: React.ReactNode }) {
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

