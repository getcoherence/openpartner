import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { alpha, softText, theme } from '../../theme.js';
import { AuthFrame, SignupTabs } from '../auth/Shared.js';
import { CountryField, countryErrorMessage } from '../../lib/CountryField.js';
import { useIsMobile } from '../../lib/useMediaQuery.js';
import {
  authErrorMessage,
  GoogleButton,
  googleStartHref,
  OrDivider,
  TextButton,
  useAuthProviders,
} from '../auth/PasswordAuth.js';
import { creatorApi, ApiError } from './creator-api.js';

type HandleStatus = 'idle' | 'checking' | 'available' | 'taken';

/** The Google-verified-signup endpoints (routes/google-auth.ts). Throws
 *  Error(code). */
async function googleSignup<T>(method: 'GET' | 'POST' | 'DELETE', body?: unknown): Promise<T> {
  const r = await fetch('/api/auth/google/creator-signup', {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    credentials: 'include',
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  if (!r.ok) throw new Error(typeof data.error === 'string' ? data.error : `${r.status}`);
  return data as T;
}

function signupErrorMessage(code: string): string {
  if (code.includes('handle_taken')) return 'That handle is already taken — pick another.';
  return countryErrorMessage(code) ?? authErrorMessage(code);
}

/**
 * Creator signup. Two ways to prove the address:
 *   - the emailed confirmation link (POST /creators/signup through the proxy);
 *   - Google. "Sign up with Google" (or "Continue with Google" on the sign-in
 *     page, for an address with no creator yet) lands here as ?google=1 with
 *     the verified address held server-side in a signed cookie. The form
 *     still asks for a name, handle and country; submitting it has the
 *     Network create the creator with no confirmation email, and the token
 *     that comes back is redeemed at /creators/verify like the link's.
 */
export function CreatorSignupPage() {
  const nav = useNavigate();
  const [params] = useSearchParams();
  const isMobile = useIsMobile();
  const providers = useAuthProviders();
  // The Google-verified address, when this signup came back from Google.
  const [googleEmail, setGoogleEmail] = useState<string | null>(null);
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
  const fromGoogle = params.get('google') === '1';

  useEffect(() => {
    if (!fromGoogle) return;
    let live = true;
    googleSignup<{ email: string }>('GET')
      .then((r) => live && setGoogleEmail(r.email))
      .catch((e: Error) => live && setErr(signupErrorMessage(e.message)));
    return () => {
      live = false;
    };
  }, [fromGoogle]);

  async function switchToOtherEmail() {
    setGoogleEmail(null);
    setErr(null);
    await googleSignup('DELETE').catch(() => undefined);
  }

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
    if (googleEmail) {
      try {
        const { token } = await googleSignup<{ token: string }>('POST', {
          name: name.trim(),
          handle: handle.trim() || undefined,
          country,
          ...(country === 'UA' ? { outsideOccupiedRegions } : {}),
        });
        await creatorApi('/creators/verify', { method: 'POST', body: { token } });
        nav('/creator', { replace: true });
      } catch (e) {
        const message = e instanceof ApiError ? ((e.detail as { error?: string } | null)?.error ?? e.message) : (e as Error).message;
        // The Google proof timed out: back to the emailed-link signup, form kept.
        if (message.includes('google_signup_expired')) setGoogleEmail(null);
        setErr(signupErrorMessage(message));
        setBusy(false);
      }
      return;
    }
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
      {!googleEmail && providers.googleStartUrl && (
        <>
          <GoogleButton href={googleStartHref(providers.googleStartUrl, 'creator')}>Sign up with Google</GoogleButton>
          <OrDivider />
        </>
      )}
      <form onSubmit={submit}>
        <Field label="Your name">
          <input name="name" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Ada Lovelace" required style={inputStyle} />
        </Field>
        {googleEmail ? (
          <Field label="Email">
            <div
              style={{
                display: 'flex',
                flexDirection: isMobile ? 'column' : 'row',
                alignItems: isMobile ? 'flex-start' : 'center',
                justifyContent: 'space-between',
                gap: isMobile ? 6 : 10,
                padding: '10px 12px',
                background: theme.surface2,
                border: `1px solid ${theme.border}`,
                borderRadius: theme.radiusSm,
                fontSize: 14,
              }}
            >
              <span style={{ wordBreak: 'break-all' }}>
                {googleEmail}{' '}
                <span style={{ fontSize: 11, color: theme.success, whiteSpace: 'nowrap' }}>✓ Verified by Google</span>
              </span>
              <TextButton onClick={switchToOtherEmail}>Use a different email</TextButton>
            </div>
          </Field>
        ) : (
          <Field label="Email" hint="We'll send your sign-in link here.">
            <input type="email" name="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="ada@example.com" required style={inputStyle} />
          </Field>
        )}
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
          {busy ? 'Creating creator…' : googleEmail ? 'Create my account' : 'Become a creator'}
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

