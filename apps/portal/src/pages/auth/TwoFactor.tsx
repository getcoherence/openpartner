import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import { renderSVG } from 'uqr';
import { api, ApiError, saveBlob } from '../../api.js';
import { theme } from '../../theme.js';
import { useTenantBase } from '../../tenant-base.js';
import { Button, Input } from '../../ui.js';
import { useNextPath, withNext } from '../../lib/signin-next.js';
import { AuthFrame } from './Shared.js';
import { Notice, postPlatform, TextButton } from './PasswordAuth.js';

/**
 * Two-step sign-in (docs/two-step-sign-in.md): the code screen a sign-in
 * stops at, and setting up an authenticator.
 */

function codeErrorMessage(err: unknown): string {
  const detail = err instanceof ApiError ? (err.detail as { error?: string; attemptsLeft?: number } | null) : null;
  const code = detail?.error ?? (err instanceof Error ? err.message : String(err));
  if (code.includes('invalid_code')) {
    const left = detail?.attemptsLeft;
    return left ? `That code didn’t work. ${left} ${left === 1 ? 'try' : 'tries'} left.` : 'That code didn’t work.';
  }
  if (code.includes('too_many_attempts')) return 'Too many wrong codes. Sign in again.';
  if (code.includes('no_pending_sign_in')) return 'This sign-in has expired. Sign in again.';
  if (code.includes('rate_limited')) return 'Too many tries. Wait a minute and try again.';
  return code || 'Something went wrong.';
}

/** A code from the authenticator app, or a recovery code. */
export function CodeForm({
  submit,
  submitLabel = 'Continue',
  allowRecovery = true,
  footer,
}: {
  submit: (code: string) => Promise<void>;
  submitLabel?: string;
  allowRecovery?: boolean;
  footer?: ReactNode;
}) {
  const [code, setCode] = useState('');
  const [recovery, setRecovery] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await submit(code.trim());
    } catch (x) {
      setErr(codeErrorMessage(x));
      setCode('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <Input
        autoFocus
        value={code}
        onChange={(e) => setCode(e.target.value)}
        inputMode={recovery ? 'text' : 'numeric'}
        autoComplete="one-time-code"
        placeholder={recovery ? 'XXXX-XXXX-XXXX' : '123456'}
        aria-label={recovery ? 'Recovery code' : 'Code'}
        maxLength={recovery ? 20 : 7}
        style={{ fontFamily: theme.fontMono, letterSpacing: '0.12em', fontSize: 16 }}
      />
      {err && <Notice tone="danger">{err}</Notice>}
      <Button type="submit" disabled={busy || code.trim().length < 6}>
        {busy ? 'Checking…' : submitLabel}
      </Button>
      {allowRecovery && (
        <TextButton
          onClick={() => {
            setRecovery(!recovery);
            setCode('');
            setErr(null);
          }}
          style={{ alignSelf: 'center' }}
        >
          {recovery ? 'Use your authenticator app' : 'Use a recovery code'}
        </TextButton>
      )}
      {footer}
    </form>
  );
}

const footerLink = { fontSize: 13, color: theme.textDim, textAlign: 'center' as const, marginTop: 4 };

/** A brand sign-in waiting for its code. The Shell shows it when whoami
 *  says so, whichever way in the person took. */
export function TwoFactorChallenge({ onDone }: { onDone: () => void }) {
  const tenantBase = useTenantBase();
  return (
    <AuthFrame title="Two-step sign-in" subtitle="Enter the code from your authenticator app.">
      <CodeForm
        submit={async (code) => {
          await api('/auth/two-factor/verify', { method: 'POST', body: { code } });
          onDone();
        }}
        footer={
          <Link to={`${tenantBase}/login`} style={footerLink}>
            Sign in again
          </Link>
        }
      />
    </AuthFrame>
  );
}

/** An OpenPartner account sign-in waiting for its code: /signin/two-factor. */
export function PlatformTwoFactorPage() {
  const nav = useNavigate();
  const next = useNextPath();
  return (
    <AuthFrame title="Two-step sign-in" subtitle="Enter the code from your authenticator app.">
      <CodeForm
        submit={async (code) => {
          await postPlatform('/auth/platform-two-factor', { code });
          nav(withNext('/workspaces', next), { replace: true });
        }}
        footer={
          <Link to={withNext('/signin', next)} style={footerLink}>
            Sign in again
          </Link>
        }
      />
    </AuthFrame>
  );
}

/** Setting up an authenticator: scan, first code, then the recovery codes. */
export function TwoFactorSetup({ onEnabled }: { onEnabled: () => void }) {
  const [setup, setSetup] = useState<{ secret: string; otpauthUri: string } | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api<{ secret: string; otpauthUri: string }>('/auth/two-factor/setup', { method: 'POST', body: {} })
      .then(setSetup)
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  }, []);

  if (err) return <Notice tone="danger">{err}</Notice>;
  if (codes) return <RecoveryCodes codes={codes} onDone={onEnabled} />;
  if (!setup) return <div style={{ color: theme.textMuted, fontSize: 14 }}>Loading…</div>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ fontSize: 14, fontWeight: 500 }}>Scan with your authenticator app</div>
      <img
        src={`data:image/svg+xml;utf8,${encodeURIComponent(renderSVG(setup.otpauthUri))}`}
        alt="QR code for your authenticator app"
        width={176}
        height={176}
        style={{ borderRadius: theme.radiusSm, alignSelf: 'flex-start' }}
      />
      <div style={{ fontSize: 12, color: theme.textMuted }}>
        Or enter this key:{' '}
        <code style={{ fontFamily: theme.fontMono, color: theme.text, wordBreak: 'break-all', userSelect: 'all' }}>
          {setup.secret.match(/.{1,4}/g)!.join(' ')}
        </code>
      </div>
      <CodeForm
        submitLabel="Turn on"
        allowRecovery={false}
        submit={async (code) => {
          const r = await api<{ recoveryCodes: string[] }>('/auth/two-factor/enable', { method: 'POST', body: { code } });
          setCodes(r.recoveryCodes);
        }}
      />
    </div>
  );
}

/** One-time recovery codes, shown once. */
export function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div>
        <div style={{ fontSize: 14, fontWeight: 500 }}>Save your recovery codes</div>
        <div style={{ fontSize: 12, color: theme.textMuted, marginTop: 4 }}>Each works once if you lose your phone. They won’t be shown again.</div>
      </div>
      <div
        aria-label="Recovery codes"
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: '6px 16px',
          padding: 14,
          background: theme.surface2,
          border: `1px solid ${theme.border}`,
          borderRadius: theme.radiusSm,
          fontFamily: theme.fontMono,
          fontSize: 13,
        }}
      >
        {codes.map((c) => (
          <span key={c}>{c}</span>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <Button variant="secondary" size="sm" onClick={() => saveBlob(new Blob([`${codes.join('\n')}\n`], { type: 'text/plain' }), 'recovery-codes.txt')}>
          Download
        </Button>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            void navigator.clipboard?.writeText(codes.join('\n'));
            setCopied(true);
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </Button>
        <Button size="sm" onClick={onDone} style={{ marginLeft: 'auto' }}>
          Done
        </Button>
      </div>
    </div>
  );
}

/** The brand requires two-step and this admin hasn't set it up. */
export function TwoFactorSetupGate({ onDone }: { onDone: () => void }) {
  const tenantBase = useTenantBase();
  return (
    <AuthFrame title="Set up two-step sign-in" subtitle="This program requires it for every admin.">
      <TwoFactorSetup onEnabled={onDone} />
      <div style={{ ...footerLink, marginTop: 18 }}>
        <TextButton
          onClick={async () => {
            await api('/auth/signout', { method: 'POST' }).catch(() => {});
            window.location.assign(`${tenantBase}/login`);
          }}
        >
          Sign out
        </TextButton>
      </div>
    </AuthFrame>
  );
}
