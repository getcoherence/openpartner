import { Link, useLocation, useNavigate, useSearchParams } from 'react-router';
import { theme } from '../theme.js';
import { useNextPath, withNext } from '../lib/signin-next.js';
import { AuthFrame } from './auth/Shared.js';
import {
  AuthNotice,
  EmailPasswordForm,
  googleStartHref,
  postPlatform,
  useAuthProviders,
  type AuthLocationState,
} from './auth/PasswordAuth.js';

/**
 * Sign-in for the multi-tenant deployment: Google, email + password, or an
 * emailed link. We don't make the user pick "brand vs creator" up front —
 * a link request looks up which accounts the address has and mails the
 * right link(s), always answering 200 to avoid email enumeration.
 * Passwords and Google are brand accounts only; creators (Network) keep
 * their emailed link.
 *
 * Password and Google sign-in end in the same POST /auth/platform-verify
 * the emailed link's landing page makes (routes/password-auth.ts).
 */
export function SigninPage() {
  const nav = useNavigate();
  const [params] = useSearchParams();
  const state = (useLocation().state ?? {}) as AuthLocationState;
  const providers = useAuthProviders();
  // ?add=1 — user clicked "Add another account" from the identity switcher.
  // Surfaces a banner so they know they're adding, not replacing, and rides
  // through to the token's purpose so verify stacks this identity onto the
  // browser's bundle instead of replacing it.
  const addMode = params.get('add') === '1';
  // ?next= — a page inside the workspace to open once signed in (e.g. a
  // creator's storefront, from /go/creators/:handle). Every path in carries
  // it: the password, the emailed link and Google.
  const next = useNextPath();

  return (
    <AuthFrame
      title={addMode ? 'Add another account' : 'Sign in'}
      subtitle={addMode ? 'Sign in to the account you want to add to this browser.' : undefined}
    >
      {addMode && (
        <div style={{ background: theme.accentA15, border: `1px solid ${theme.accentA55}`, padding: 12, borderRadius: theme.radiusSm, fontSize: 12, color: theme.textMuted, marginBottom: 14 }}>
          You&rsquo;re adding a second account. Your current account stays signed in &mdash; you&rsquo;ll be able to switch between them from the sidebar.
        </div>
      )}
      <AuthNotice error={params.get('error')} reset={state.reset} />
      <EmailPasswordForm
        initialEmail={state.email}
        googleHref={
          providers.googleStartUrl
            ? googleStartHref(providers.googleStartUrl, addMode ? 'account_add' : 'account', null, next)
            : null
        }
        onPassword={async (email, password) => {
          const { token } = await postPlatform<{ token: string }>('/signin/password', { email, password, add: addMode });
          await postPlatform('/auth/platform-verify', { token });
          nav(withNext('/workspaces', next), { replace: true });
        }}
        onLink={(email) => postPlatform('/signin', { email, add: addMode, ...(next ? { next } : {}) }).then(() => undefined)}
        onForgot={(email) => postPlatform('/password/forgot', { email }).then(() => undefined)}
        linkSentText={(email) =>
          addMode
            ? `If ${email} is an admin on a brand, we just emailed it a sign-in link. If it isn’t, we emailed it to say so.`
            : `If we found accounts for ${email}, we just emailed sign-in links — one per account type if you have both a brand and a creator account. They’re good for 15 minutes.`
        }
        forgotSentText={(email) =>
          `If ${email} has an OpenPartner brand or operator account, we just emailed it a link to choose a password. It’s good for 15 minutes. A partner address gets a list of its partner portals instead.`
        }
        forgotHint="Partners: reset your password from your brand’s partner portal."
        footer={
          <div style={{ marginTop: 14, fontSize: 12, color: theme.textDim, textAlign: 'center' }}>
            New here? <Link to="/signup" style={{ color: theme.accentText }}>Sign up as a brand</Link> · <Link to="/creator/signup" style={{ color: theme.accentText }}>Sign up as a creator</Link>
          </div>
        }
      />
    </AuthFrame>
  );
}
