import { useState, type CSSProperties, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Eye, EyeOff } from 'lucide-react';
import { theme } from '../../theme.js';
import { countryErrorMessage } from '../../lib/CountryField.js';

/**
 * Shared pieces of password + Google sign-in. The API side
 * (routes/password-auth.ts, routes/google-auth.ts) never sets a session
 * itself: a correct password returns the token a sign-in email would have
 * carried, and the page redeems it at the same verify endpoint the emailed
 * link's landing page uses.
 */

export const MIN_PASSWORD_LENGTH = 10;

/** sessionStorage key: the plan picked on /signup before "Sign up with
 *  Google", preselected on /brands/new when the round trip lands there. */
export const SIGNUP_PLAN_KEY = 'op:signup-plan';

export interface AuthProviders {
  google: boolean;
  /** Absolute, on the platform origin — white-label portals start Google
   *  there too, so its state cookie and callback share a host. */
  googleStartUrl: string | null;
}

export function useAuthProviders(): AuthProviders {
  const q = useQuery({
    queryKey: ['auth-providers'],
    queryFn: async (): Promise<AuthProviders> => {
      const r = await fetch('/api/auth/providers', { credentials: 'include' });
      if (!r.ok) return { google: false, googleStartUrl: null };
      return (await r.json()) as AuthProviders;
    },
    staleTime: Infinity,
  });
  return q.data ?? { google: false, googleStartUrl: null };
}

export function googleStartHref(
  startUrl: string,
  flow: 'account' | 'account_add' | 'ops' | 'portal',
  slug?: string | null,
  /** account flows: where to land after entering a workspace (lib/signin-next.ts). */
  next?: string | null,
): string {
  const url = new URL(startUrl, window.location.origin);
  url.searchParams.set('flow', flow);
  if (slug) url.searchParams.set('slug', slug);
  if (next) url.searchParams.set('next', next);
  return url.toString();
}

/** POST JSON to a platform-level endpoint (no /t/<slug> prefix). Throws
 *  an Error whose message is the API's error code. */
export async function postPlatform<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(`/api${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(body),
  });
  const data = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  if (!r.ok) throw new Error(typeof data.error === 'string' ? data.error : `${r.status}`);
  return data as T;
}

/** Plain-language text for the auth error codes, including ?error= from a
 *  failed Google round trip. */
export function authErrorMessage(code: string): string {
  const country = countryErrorMessage(code);
  if (country) return country;
  // Can't say whether the account has a password (that would tell anyone
  // which addresses do), so the message covers the link-only account too.
  if (code.includes('invalid_credentials') || code === 'unauthorized')
    return 'That email and password don’t match. Never set a password? Use “Forgot password?” to choose one, or have a sign-in link emailed to you.';
  if (code.includes('too_many_attempts'))
    return 'Too many wrong passwords. Wait 15 minutes, or have a sign-in link emailed to you.';
  if (code.includes('rate_limited')) return 'Too many requests — wait a minute and try again.';
  if (code.includes('current_password_incorrect')) return 'Your current password isn’t right.';
  if (code.includes('invalid_or_expired_token')) return 'This link is invalid or has expired. Ask for a new one.';
  if (code.includes('wrong_token_kind')) return 'This link is for something else. Ask for a new one.';
  if (code.includes('pending_review'))
    return 'Your application is still being reviewed. You’ll get an email once you’re approved.';
  if (code.includes('portal_access_disabled'))
    return 'Your account doesn’t have access to this portal. Contact the program if you think it should.';
  if (code.includes('google_cancelled')) return 'Google sign-in was cancelled.';
  if (code.includes('google_unverified')) return 'Google hasn’t verified that email address, so we can’t use it to sign you in.';
  if (code.includes('google_no_account'))
    return 'No account here uses that Google address. Sign in with the email you were invited with.';
  if (code.includes('google_unavailable')) return 'Google sign-in isn’t set up on this deployment.';
  if (code.includes('google_failed')) return 'Google sign-in didn’t work. Try again.';
  if (code.includes('not_an_operator')) return 'That account isn’t an OpenPartner operator.';
  if (code.includes('invalid_body')) return `Check the fields — passwords need at least ${MIN_PASSWORD_LENGTH} characters.`;
  return code || 'Something went wrong. Try again.';
}

/** A Google error bounced back in ?error=, or "password saved" after a
 *  reset (router state). */
export function AuthNotice({ error, reset }: { error: string | null; reset?: boolean }) {
  if (error) return <Notice tone="danger">{authErrorMessage(error)}</Notice>;
  if (reset) return <Notice tone="success">Password saved. Sign in with it below.</Notice>;
  return null;
}

/** What a reset hands the sign-in page (router state, never the URL). */
export interface AuthLocationState {
  email?: string;
  reset?: boolean;
}

export function Notice({ tone, children }: { tone: 'success' | 'danger' | 'info'; children: ReactNode }) {
  const color = tone === 'success' ? theme.success : tone === 'danger' ? theme.danger : theme.textMuted;
  const bg = tone === 'success' ? theme.successSoft : tone === 'danger' ? theme.dangerSoft : theme.surface2;
  return (
    <div
      style={{
        background: bg,
        border: `1px solid ${tone === 'info' ? theme.border : color}`,
        color,
        padding: '10px 12px',
        borderRadius: theme.radiusSm,
        fontSize: 13,
        marginBottom: 14,
      }}
    >
      {children}
    </div>
  );
}

export function GoogleButton({ href, children = 'Continue with Google' }: { href: string; children?: ReactNode }) {
  return (
    <a
      href={href}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 10,
        width: '100%',
        padding: '10px 14px',
        background: theme.surface2,
        border: `1px solid ${theme.border}`,
        borderRadius: theme.radiusSm,
        color: theme.text,
        fontSize: 14,
        fontWeight: 500,
        textDecoration: 'none',
        boxSizing: 'border-box',
      }}
    >
      <GoogleMark />
      {children}
    </a>
  );
}

function GoogleMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
      <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
    </svg>
  );
}

export function OrDivider() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '16px 0', color: theme.textDim, fontSize: 12 }}>
      <div style={{ flex: 1, height: 1, background: theme.border }} />
      or
      <div style={{ flex: 1, height: 1, background: theme.border }} />
    </div>
  );
}

/** Password input with a show/hide toggle. */
export function PasswordInput({
  value,
  onChange,
  autoComplete,
  placeholder,
  style,
  autoFocus,
  name = 'password',
}: {
  value: string;
  onChange: (v: string) => void;
  autoComplete: 'current-password' | 'new-password';
  placeholder?: string;
  style?: CSSProperties;
  autoFocus?: boolean;
  name?: string;
}) {
  const [shown, setShown] = useState(false);
  return (
    <div style={{ position: 'relative' }}>
      <input
        type={shown ? 'text' : 'password'}
        name={name}
        autoComplete={autoComplete}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoFocus={autoFocus}
        required
        minLength={autoComplete === 'new-password' ? MIN_PASSWORD_LENGTH : undefined}
        maxLength={200}
        style={{ ...passwordInputStyle, ...style, paddingRight: 38 }}
      />
      <button
        type="button"
        onClick={() => setShown((s) => !s)}
        aria-label={shown ? 'Hide password' : 'Show password'}
        style={{
          position: 'absolute',
          right: 6,
          top: '50%',
          transform: 'translateY(-50%)',
          background: 'transparent',
          border: 'none',
          color: theme.textDim,
          cursor: 'pointer',
          padding: 6,
          display: 'flex',
        }}
      >
        {shown ? <EyeOff size={15} /> : <Eye size={15} />}
      </button>
    </div>
  );
}

const passwordInputStyle: CSSProperties = {
  width: '100%',
  padding: '10px 12px',
  fontSize: 14,
  background: theme.surface2,
  border: `1px solid ${theme.border}`,
  borderRadius: theme.radiusSm,
  color: theme.text,
  boxSizing: 'border-box',
};

/** Small text-styled button for "Forgot password?" and friends. */
export function TextButton({ onClick, children, style }: { onClick: () => void; children: ReactNode; style?: CSSProperties }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        background: 'transparent',
        border: 'none',
        padding: 0,
        color: theme.accentText,
        fontSize: 12,
        cursor: 'pointer',
        ...style,
      }}
    >
      {children}
    </button>
  );
}

/** "New password" + "Confirm" pair with the length rule. Returns the
 *  inputs and a validation message (null when submittable). */
export function useNewPassword(): {
  password: string;
  fields: ReactNode;
  problem: string | null;
} {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const problem =
    password.length < MIN_PASSWORD_LENGTH
      ? `At least ${MIN_PASSWORD_LENGTH} characters.`
      : password !== confirm
        ? 'The two passwords don’t match.'
        : null;
  const fields = (
    <>
      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 12, color: theme.textMuted, marginBottom: 4 }}>New password</div>
        <PasswordInput value={password} onChange={setPassword} autoComplete="new-password" autoFocus />
        <div style={{ fontSize: 11, color: theme.textDim, marginTop: 4 }}>
          At least {MIN_PASSWORD_LENGTH} characters. A few unrelated words works well.
        </div>
      </div>
      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 12, color: theme.textMuted, marginBottom: 4 }}>Confirm new password</div>
        <PasswordInput value={confirm} onChange={setConfirm} autoComplete="new-password" name="confirm-password" />
        {confirm.length > 0 && password !== confirm && (
          <div style={{ fontSize: 11, color: theme.danger, marginTop: 4 }}>The two passwords don’t match.</div>
        )}
      </div>
    </>
  );
  return { password, fields, problem };
}

type FormMode = 'password' | 'link' | 'forgot';

/**
 * Email + password form with the two fallbacks every sign-in page offers:
 * "Forgot password?" (also how a link-only account sets its first
 * password) and "Email me a sign-in link instead". Pages supply what each
 * action calls; they throw Error(code) on failure and `onPassword`
 * navigates away on success.
 */
export function EmailPasswordForm({
  initialEmail = '',
  googleHref,
  googleLabel,
  onPassword,
  onLink,
  onForgot,
  linkSentText,
  forgotSentText,
  forgotHint,
  emailPlaceholder = 'you@example.com',
  footer,
}: {
  initialEmail?: string;
  googleHref?: string | null;
  googleLabel?: string;
  onPassword: (email: string, password: string) => Promise<void>;
  onLink: (email: string) => Promise<void>;
  onForgot: (email: string) => Promise<void>;
  linkSentText: (email: string) => ReactNode;
  forgotSentText: (email: string) => ReactNode;
  /** Extra line under the "forgot password" explanation. */
  forgotHint?: ReactNode;
  emailPlaceholder?: string;
  footer?: ReactNode;
}) {
  const [mode, setMode] = useState<FormMode>('password');
  const [email, setEmail] = useState(initialEmail);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [sent, setSent] = useState<FormMode | null>(null);

  function switchTo(next: FormMode) {
    setMode(next);
    setErr(null);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    const address = email.trim();
    try {
      if (mode === 'password') {
        await onPassword(address, password);
        return;
      }
      if (mode === 'forgot') await onForgot(address);
      else await onLink(address);
      setSent(mode);
    } catch (e) {
      setErr(authErrorMessage(e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <>
        <Notice tone="success">{sent === 'forgot' ? forgotSentText(email.trim()) : linkSentText(email.trim())}</Notice>
        <div style={{ textAlign: 'center' }}>
          <TextButton
            onClick={() => {
              setSent(null);
              switchTo('password');
            }}
          >
            Back to sign in
          </TextButton>
        </div>
      </>
    );
  }

  const disabled = busy || !email || (mode === 'password' && !password);
  const label = busy
    ? mode === 'password'
      ? 'Signing in…'
      : 'Sending…'
    : mode === 'password'
      ? 'Sign in'
      : mode === 'forgot'
        ? 'Email me a password link'
        : 'Email me a sign-in link';

  return (
    <>
      {googleHref && mode !== 'forgot' && (
        <>
          <GoogleButton href={googleHref}>{googleLabel}</GoogleButton>
          <OrDivider />
        </>
      )}
      <form onSubmit={submit}>
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 12, color: theme.textMuted, marginBottom: 4 }}>Email</div>
          <input
            type="email"
            name="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder={emailPlaceholder}
            required
            autoFocus={!initialEmail}
            style={passwordInputStyle}
          />
        </div>
        {mode === 'password' && (
          <div style={{ marginBottom: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 }}>
              <div style={{ fontSize: 12, color: theme.textMuted }}>Password</div>
              <TextButton onClick={() => switchTo('forgot')}>Forgot password?</TextButton>
            </div>
            <PasswordInput value={password} onChange={setPassword} autoComplete="current-password" autoFocus={!!initialEmail} />
          </div>
        )}
        {mode === 'forgot' && (
          <div style={{ fontSize: 12, color: theme.textDim, marginBottom: 12, lineHeight: 1.5 }}>
            We&rsquo;ll email you a link to choose a new password. Never had one? This sets your first.
            {forgotHint && <div style={{ marginTop: 6 }}>{forgotHint}</div>}
          </div>
        )}
        {err && <div style={{ color: theme.danger, fontSize: 13, marginBottom: 8 }}>{err}</div>}
        <button type="submit" disabled={disabled} style={primaryButtonStyle(disabled)}>
          {label}
        </button>
        <div style={{ marginTop: 12, textAlign: 'center' }}>
          {mode === 'password' ? (
            <TextButton onClick={() => switchTo('link')}>Email me a sign-in link instead</TextButton>
          ) : (
            <TextButton onClick={() => switchTo('password')}>Sign in with a password instead</TextButton>
          )}
        </div>
        {footer}
      </form>
    </>
  );
}

export function primaryButtonStyle(disabled: boolean): CSSProperties {
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
