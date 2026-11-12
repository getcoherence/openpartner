import { Link, useLocation, useNavigate, useSearchParams } from 'react-router';
import { theme } from '../theme.js';
import { useNextPath, withNext } from '../lib/signin-next.js';
import { AuthFrame, AuthPanel } from './auth/Shared.js';
import {
  AuthNotice,
  EmailPasswordForm,
  googleStartHref,
  postPlatform,
  useAuthProviders,
  type AuthLocationState,
} from './auth/PasswordAuth.js';
import { creatorApi } from './creator/creator-api.js';
import { creatorPasswordToken, redeemCreatorToken } from './creator/CreatorSignin.js';

/** The brand side's "not this password" answers, after which the same
 *  password is tried as the address's creator password. */
const PASSWORD_REFUSALS = new Set(['invalid_credentials', 'too_many_attempts']);

/**
 * The creator half of a password the brand side refused. Each side answers
 * a wrong password, an unknown address and a link-only account alike, so
 * trying both says nothing about which accounts the address has. If the
 * Network refuses too, the brand side's answer stands, unless the Network
 * is holding the address or this browser: then that's the reason to show.
 */
async function signInAsCreator(email: string, password: string, brandError: Error): Promise<void> {
  let token: string;
  try {
    token = await creatorPasswordToken(email, password);
  } catch (e) {
    const code = e instanceof Error ? e.message : '';
    throw code === 'too_many_attempts' || code === 'rate_limited' ? e : brandError;
  }
  // The password matched: whatever stops the session now (a takedown, a
  // deletion in progress, the country check) is worth saying as-is.
  await redeemCreatorToken(token);
}

/**
 * Sign-in for the multi-tenant deployment: Google, email + password, or an
 * emailed link. We don't make the user pick "brand vs creator" up front —
 * a link request looks up which accounts the address has and mails the
 * right link(s), always answering 200 to avoid email enumeration. A
 * password is tried as the brand or operator one first, then as the
 * creator one (the Network's), and "Forgot password?" asks both. Google
 * covers both too: an address with no brand to enter that is an active
 * creator lands in the creator portal (accountLanding in
 * routes/google-auth.ts). With both kinds of account it's the brand, and
 * "Add another account" (?add=1) only ever adds a brand account.
 *
 * Brand passwords and brand Google sign-in end in the same POST
 * /auth/platform-verify the emailed link's landing page makes
 * (routes/password-auth.ts); a creator password or creator Google sign-in
 * ends in the Network's POST /creators/verify (Google's via
 * /creator/auth/magic).
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
      panel={<AuthPanel variant="signin" />}
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
          let token: string;
          try {
            ({ token } = await postPlatform<{ token: string }>('/signin/password', { email, password, add: addMode }));
          } catch (e) {
            // Adding a second account adds a brand account; anything else
            // may be signing in with the address's creator password.
            if (addMode || !(e instanceof Error) || !PASSWORD_REFUSALS.has(e.message)) throw e;
            await signInAsCreator(email, password, e);
            nav('/creator', { replace: true });
            return;
          }
          const verified = await postPlatform<{ twoFactorRequired?: boolean }>('/auth/platform-verify', { token });
          nav(withNext(verified.twoFactorRequired ? '/signin/two-factor' : '/workspaces', next), { replace: true });
        }}
        onLink={(email) => postPlatform('/signin', { email, add: addMode, ...(next ? { next } : {}) }).then(() => undefined)}
        onForgot={(email) =>
          Promise.all([
            postPlatform('/password/forgot', { email }),
            // The Network mails a creator its own reset link, and answers
            // the same 200 for an address that isn't one.
            addMode ? null : creatorApi('/creators/password/forgot', { method: 'POST', body: { email } }).catch(() => undefined),
          ]).then(() => undefined)
        }
        linkSentText={(email) =>
          addMode
            ? `If ${email} is an admin on a brand, we just emailed it a sign-in link. If it isn’t, we emailed it to say so.`
            : `If we found accounts for ${email}, we just emailed sign-in links — one per account type if you have both a brand and a creator account. They’re good for 15 minutes.`
        }
        forgotSentText={(email) =>
          `If ${email} has an OpenPartner ${addMode ? 'brand or operator' : 'brand, creator or operator'} account, we just emailed it a link to choose a password. It’s good for 15 minutes. A partner address gets a list of its partner portals instead.`
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
