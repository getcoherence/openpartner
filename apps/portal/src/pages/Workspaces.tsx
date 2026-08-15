import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { theme } from '../theme.js';
import { Logo } from './auth/Shared.js';

interface Workspace {
  tenantSlug: string;
  tenantDisplayName: string;
  adminId: string;
  activated: boolean;
}

interface WorkspacesResponse {
  email: string;
  workspaces: Workspace[];
}

/**
 * Post-platform-signin picker. The platform magic-link verify creates
 * an identity session; this page lists the brands the verified email
 * admins and lets the user enter one. Auto-skips when there's only one
 * workspace.
 */
export function WorkspacesPage() {
  const nav = useNavigate();
  const [data, setData] = useState<WorkspacesResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busySlug, setBusySlug] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/me/workspaces', { credentials: 'include' })
      .then(async (r) => {
        if (r.status === 401) {
          if (!cancelled) nav('/signin', { replace: true });
          return null;
        }
        if (!r.ok) throw new Error(`${r.status}`);
        return (await r.json()) as WorkspacesResponse;
      })
      .then((d) => {
        if (cancelled || !d) return;
        if (d.workspaces.length === 1) {
          // Single brand — skip the picker.
          enter(d.workspaces[0]!.tenantSlug);
          return;
        }
        setData(d);
      })
      .catch((e) => setErr(e instanceof Error ? e.message : 'Could not load workspaces.'));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nav]);

  async function enter(slug: string) {
    setBusySlug(slug);
    setErr(null);
    try {
      const r = await fetch('/api/workspaces/enter', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ slug }),
      });
      const j = (await r.json()) as { ok?: boolean; home?: string; error?: string };
      if (!r.ok || !j.ok || !j.home) throw new Error(j.error ?? `${r.status}`);
      nav(j.home, { replace: true });
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not enter workspace.');
      setBusySlug(null);
    }
  }

  if (!data && !err) {
    return <div style={{ minHeight: '100vh', background: theme.bg }} />;
  }

  return (
    <div style={{ minHeight: '100vh', background: theme.bg, color: theme.text, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      <div style={{ maxWidth: 460, width: '100%' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 28 }}>
          <Logo />
          <div style={{ fontSize: 16, fontWeight: 600 }}>OpenPartner</div>
        </div>
        <h1 style={{ fontSize: 24, fontWeight: 700, margin: '0 0 6px', letterSpacing: '-0.01em' }}>Pick a workspace</h1>
        <p style={{ color: theme.textMuted, fontSize: 14, marginTop: 0, marginBottom: 20 }}>
          {data ? `Signed in as ${data.email}.` : null}
        </p>
        {err && <div style={{ color: theme.danger, fontSize: 13, marginBottom: 12 }}>{err}</div>}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {data?.workspaces.map((w) => (
            <button
              key={w.tenantSlug}
              onClick={() => enter(w.tenantSlug)}
              disabled={busySlug !== null}
              style={{
                background: theme.surface,
                border: `1px solid ${theme.borderSubtle}`,
                borderRadius: theme.radiusSm,
                padding: '14px 16px',
                color: theme.text,
                textAlign: 'left',
                cursor: busySlug === null ? 'pointer' : 'wait',
                opacity: busySlug !== null && busySlug !== w.tenantSlug ? 0.5 : 1,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 12,
              }}
            >
              <div>
                <div style={{ fontWeight: 600, fontSize: 14 }}>{w.tenantDisplayName}</div>
                <div style={{ color: theme.textMuted, fontSize: 12, marginTop: 2 }}>
                  /t/{w.tenantSlug}/{!w.activated && ' · activates on entry'}
                </div>
              </div>
              <span style={{ color: theme.accent, fontSize: 13 }}>
                {busySlug === w.tenantSlug ? 'Entering…' : 'Enter →'}
              </span>
            </button>
          ))}
        </div>
        {data?.workspaces.length === 0 && (
          <div style={{ color: theme.textMuted, fontSize: 14 }}>
            You don&rsquo;t have any brand workspaces. <a href="/brands/new" style={{ color: theme.accent }}>Create one →</a>
          </div>
        )}
      </div>
    </div>
  );
}
