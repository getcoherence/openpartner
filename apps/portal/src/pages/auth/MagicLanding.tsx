import { useEffect, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { safePortalPath } from '@openpartner/db';
import { api, clearApiKey } from '../../api.js';
import { theme } from '../../theme.js';
import { countryErrorMessage } from '../../lib/CountryField.js';
import { AuthFrame } from './Shared.js';
import { stripQueryParamsFromAddressBar } from '../../lib/sensitive-url.js';

/**
 * Terminal page for an emailed magic link. URL shapes:
 *   single-tenant: /auth/magic?token=...
 *   multi-tenant brand: /t/<slug>/auth/magic?token=...
 *
 * After verify we redirect to the right home: /t/<slug>/ for a brand
 * link (slug pulled from the URL we landed on), or / for single-tenant.
 * Without this, multi-tenant brand admins were getting bounced back to
 * the public Landing because / is the Landing in multi-tenant mode.
 *
 * A link the brand's backend minted (POST /partners/{id}/signin-link) may
 * carry ?next=<portal path> (its `returnTo`): we land there instead, under
 * the same /t/<slug> prefix, if safePortalPath accepts it.
 */
export function MagicLandingPage() {
  const [params] = useSearchParams();
  const nav = useNavigate();
  const location = useLocation();
  const qc = useQueryClient();
  const [state, setState] = useState<'verifying' | 'ok' | 'failed'>('verifying');
  const [detail, setDetail] = useState<string | null>(null);

  useEffect(() => {
    const token = params.get('token');
    // The token signs in whoever holds it until verify spends it: take it
    // out of the address bar (and so out of history, Referer headers and
    // analytics pageviews) before anything else runs.
    stripQueryParamsFromAddressBar(['token']);
    if (!token) {
      setState('failed');
      setDetail('No token in URL.');
      return;
    }
    const slugMatch = location.pathname.match(/^\/t\/([a-z0-9-]+)\/auth\/magic$/);
    const base = slugMatch ? `/t/${slugMatch[1]}` : '';
    const next = safePortalPath(params.get('next'));
    const home = next ? `${base}${next}` : `${base}/`;

    clearApiKey();
    api<{ ok: boolean }>('/auth/magic/verify', { method: 'POST', body: { token } })
      .then(() => {
        // After a successful first-run activation the install-status
        // probe was cached (staleTime: Infinity) with needsSetup=true
        // from app boot, so / would redirect right back to /install.
        // Invalidate so the Shell re-reads and admits the newly
        // activated admin into the dashboard.
        qc.invalidateQueries({ queryKey: ['install-status'] });
        setState('ok');
        setTimeout(() => nav(home, { replace: true }), 400);
      })
      .catch((err) => {
        setState('failed');
        const message =
          err && typeof err === 'object' && 'message' in err ? String((err as { message: unknown }).message) : '';
        setDetail(
          message.includes('pending_review')
            ? "Your application is still being reviewed. You'll get an email with a sign-in link once you're approved."
            : countryErrorMessage(message)
              ? countryErrorMessage(message)!
              : message.includes('portal_access_disabled')
              ? 'Your account doesn\'t have access to this portal. Contact the program if you think it should.'
              : message || 'Link is invalid or expired.',
        );
      });
  }, [nav, params, qc, location.pathname]);

  return (
    <AuthFrame title="Signing you in" subtitle="One moment…">
      {state === 'verifying' && <div style={{ color: theme.textMuted, fontSize: 14 }}>Verifying your link…</div>}
      {state === 'ok' && <div style={{ color: theme.success, fontSize: 14 }}>Signed in. Redirecting…</div>}
      {state === 'failed' && (
        <div style={{ color: theme.danger, fontSize: 14 }}>
          {detail ?? 'Could not verify.'}
          {/* A new link can't help someone held for review or without access. */}
          {!detail?.startsWith('Your application') && !detail?.startsWith('Your account') && (
            <div style={{ color: theme.textDim, fontSize: 13, marginTop: 10 }}>
              Ask for a new link from the sign-in page.
            </div>
          )}
        </div>
      )}
    </AuthFrame>
  );
}
