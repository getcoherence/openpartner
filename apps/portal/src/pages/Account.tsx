import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../api.js';
import { theme } from '../theme.js';
import { Card, Page } from '../ui.js';
import { Logo } from './auth/Shared.js';
import { authErrorMessage, Notice, PasswordInput, primaryButtonStyle, useNewPassword } from './auth/PasswordAuth.js';

interface PasswordBody {
  currentPassword?: string;
  password: string;
}

/**
 * Set or change a password. With one already set, the current password is
 * required (the API enforces it too).
 */
function PasswordForm({ hasPassword, onSave }: { hasPassword: boolean; onSave: (body: PasswordBody) => Promise<void> }) {
  const [current, setCurrent] = useState('');
  const { password, fields, problem } = useNewPassword();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const blocked = busy || !!problem || (hasPassword && !current);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (blocked) return;
    setBusy(true);
    setErr(null);
    try {
      await onSave({ ...(hasPassword ? { currentPassword: current } : {}), password });
    } catch (e) {
      setErr(authErrorMessage(e instanceof Error ? e.message : String(e)));
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} style={{ maxWidth: 380 }}>
      {hasPassword && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 12, color: theme.textMuted, marginBottom: 4 }}>Current password</div>
          <PasswordInput value={current} onChange={setCurrent} autoComplete="current-password" name="current-password" />
        </div>
      )}
      {fields}
      {err && <div style={{ color: theme.danger, fontSize: 13, marginBottom: 8 }}>{err}</div>}
      <button type="submit" disabled={blocked} style={{ ...primaryButtonStyle(blocked), width: 'auto', padding: '9px 18px' }}>
        {busy ? 'Saving…' : hasPassword ? 'Change password' : 'Set password'}
      </button>
    </form>
  );
}

/** Password card with its saved state; remounts the form after a save so
 *  the fields clear. */
function PasswordSection({
  hasPassword,
  onSave,
  sharedNote,
}: {
  hasPassword: boolean;
  onSave: (body: PasswordBody) => Promise<void>;
  sharedNote?: string;
}) {
  const [saves, setSaves] = useState(0);
  return (
    <Card>
      <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 4 }}>Password</div>
      <div style={{ color: theme.textMuted, fontSize: 13, marginBottom: 16, lineHeight: 1.5 }}>
        {hasPassword
          ? 'You can sign in with your email and password. Emailed sign-in links keep working too.'
          : 'You sign in with emailed links. Set a password to sign in without waiting for an email.'}
        {sharedNote ? ` ${sharedNote}` : ''}
      </div>
      {saves > 0 && <Notice tone="success">Password saved.</Notice>}
      <PasswordForm
        key={saves}
        hasPassword={hasPassword}
        onSave={async (body) => {
          await onSave(body);
          setSaves((n) => n + 1);
        }}
      />
    </Card>
  );
}

const SHARED_NOTE = 'It’s the same password for every brand you admin and, for staff, the ops console.';

interface PlatformPassword {
  email: string;
  hasPassword: boolean;
}

async function loadPlatformPassword(): Promise<PlatformPassword | null> {
  const r = await fetch('/api/me/password', { credentials: 'include' });
  if (r.status === 401) return null;
  if (!r.ok) throw new Error(`${r.status}`);
  return (await r.json()) as PlatformPassword;
}

async function savePlatformPassword(body: PasswordBody): Promise<void> {
  const r = await fetch('/api/me/password', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const j = (await r.json().catch(() => ({}))) as { error?: string };
    throw new Error(j.error ?? `${r.status}`);
  }
}

/**
 * /account — the platform identity's password (multi-tenant). Reached from
 * the workspace picker and the sidebar's account menu.
 */
export function AccountPage() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['me-password'], queryFn: loadPlatformPassword });

  useEffect(() => {
    if (q.data === null) nav('/signin', { replace: true });
  }, [q.data, nav]);

  return (
    <div style={{ minHeight: '100vh', background: theme.bg, color: theme.text, display: 'flex', justifyContent: 'center', padding: 24 }}>
      <div style={{ maxWidth: 520, width: '100%', paddingTop: 40 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 28 }}>
          <Logo />
          <div style={{ fontSize: 16, fontWeight: 600 }}>OpenPartner</div>
        </div>
        <h1 style={{ fontSize: 24, fontWeight: 700, margin: '0 0 6px', letterSpacing: '-0.01em' }}>Account</h1>
        <p style={{ color: theme.textMuted, fontSize: 14, marginTop: 0, marginBottom: 20 }}>
          {q.data ? `Signed in as ${q.data.email}.` : ' '}
        </p>
        {q.isError && <Notice tone="danger">Couldn’t load your account. Refresh to try again.</Notice>}
        {q.data && (
          <PasswordSection
            hasPassword={q.data.hasPassword}
            sharedNote={SHARED_NOTE}
            onSave={async (body) => {
              await savePlatformPassword(body);
              await qc.invalidateQueries({ queryKey: ['me-password'] });
            }}
          />
        )}
        <div style={{ marginTop: 16, fontSize: 13 }}>
          <Link to="/workspaces" style={{ color: theme.accentText }}>
            ← Back to your workspaces
          </Link>
        </div>
      </div>
    </div>
  );
}

type TenantPassword = { managedOn: 'here'; hasPassword: boolean } | { managedOn: 'account'; accountUrl: string };

/**
 * <brand>/account — password for whoever is signed in to this brand. A
 * partner's (or a single-tenant admin's) is managed right here. A hosted
 * admin's is the platform password; it's managed here too when this origin
 * holds the platform session, otherwise on the platform's /account.
 */
export function TenantAccountPage() {
  const qc = useQueryClient();
  const tenant = useQuery({
    queryKey: ['tenant-password'],
    queryFn: async (): Promise<TenantPassword | 'session_required'> => {
      try {
        return await api<TenantPassword>('/auth/password');
      } catch (e) {
        if (e instanceof ApiError && e.status === 403) return 'session_required';
        throw e;
      }
    },
  });
  const managedOnAccount = tenant.data !== undefined && tenant.data !== 'session_required' && tenant.data.managedOn === 'account';
  const platform = useQuery({ queryKey: ['me-password'], queryFn: loadPlatformPassword, enabled: managedOnAccount });

  let body: React.ReactNode = null;
  if (tenant.isError) body = <Notice tone="danger">Couldn’t load your sign-in settings. Refresh to try again.</Notice>;
  else if (tenant.data === 'session_required')
    body = <Notice tone="info">You’re signed in with an API key. Passwords are for people who sign in with their email.</Notice>;
  else if (tenant.data?.managedOn === 'here') {
    body = (
      <PasswordSection
        hasPassword={tenant.data.hasPassword}
        onSave={async (b) => {
          await api('/auth/password', { method: 'PUT', body: b });
          await qc.invalidateQueries({ queryKey: ['tenant-password'] });
        }}
      />
    );
  } else if (tenant.data?.managedOn === 'account') {
    if (platform.data) {
      body = (
        <PasswordSection
          hasPassword={platform.data.hasPassword}
          sharedNote={SHARED_NOTE}
          onSave={async (b) => {
            await savePlatformPassword(b);
            await qc.invalidateQueries({ queryKey: ['me-password'] });
          }}
        />
      );
    } else if (platform.data === null || platform.isError) {
      body = (
        <Card>
          <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 4 }}>Password</div>
          <div style={{ color: theme.textMuted, fontSize: 13, lineHeight: 1.5 }}>
            Your password is shared by every brand you admin, so it’s managed on your OpenPartner account.{' '}
            <a href={tenant.data.accountUrl} style={{ color: theme.accentText }}>
              Open account settings →
            </a>
          </div>
        </Card>
      );
    }
  }

  return (
    <Page title="Sign-in & password" subtitle="How you sign in to this portal.">
      <div style={{ maxWidth: 560 }}>{body}</div>
    </Page>
  );
}
