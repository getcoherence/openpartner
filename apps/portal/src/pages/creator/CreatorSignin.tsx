import { Link, useLocation, useNavigate, useSearchParams } from 'react-router';
import { theme } from '../../theme.js';
import { AuthFrame } from '../auth/Shared.js';
import {
  AuthNotice,
  EmailPasswordForm,
  googleStartHref,
  useAuthProviders,
  type AuthLocationState,
} from '../auth/PasswordAuth.js';
import { creatorApi, ApiError } from './creator-api.js';

/** The Network's error code, for authErrorMessage. */
export function creatorErrorCode(e: unknown): Error {
  if (e instanceof ApiError) {
    const d = e.detail as { error?: unknown } | null;
    return new Error(typeof d?.error === 'string' ? d.error : e.message);
  }
  return e instanceof Error ? e : new Error(String(e));
}

/**
 * Creator sign-in: email + password, "Continue with Google", or an emailed
 * link. Every way ends at the Network's POST /creators/verify, which makes
 * the session: a correct password returns the token the sign-in email would
 * have carried and we redeem it here; Google lands on /creator/auth/magic
 * with that token (routes/google-auth.ts, flow=creator).
 */
export function CreatorSigninPage() {
  const nav = useNavigate();
  const [params] = useSearchParams();
  const state = (useLocation().state ?? {}) as AuthLocationState;
  const providers = useAuthProviders();

  return (
    <AuthFrame title="Creator sign in" subtitle="Sign in to your OpenPartner Network creator account.">
      <AuthNotice error={params.get('error')} reset={state.reset} />
      <EmailPasswordForm
        initialEmail={state.email}
        emailPlaceholder="ada@example.com"
        googleHref={providers.googleStartUrl ? googleStartHref(providers.googleStartUrl, 'creator') : null}
        onPassword={async (email, password) => {
          try {
            const { token } = await creatorApi<{ token: string }>('/creators/signin/password', {
              method: 'POST',
              body: { email, password },
            });
            await creatorApi('/creators/verify', { method: 'POST', body: { token } });
          } catch (e) {
            throw creatorErrorCode(e);
          }
          nav('/creator', { replace: true });
        }}
        onLink={(email) =>
          creatorApi('/creators/signin', { method: 'POST', body: { email } }).then(
            () => undefined,
            (e) => Promise.reject(creatorErrorCode(e)),
          )
        }
        onForgot={(email) =>
          creatorApi('/creators/password/forgot', { method: 'POST', body: { email } }).then(
            () => undefined,
            (e) => Promise.reject(creatorErrorCode(e)),
          )
        }
        linkSentText={(email) => `If an account exists for ${email}, we sent a sign-in link. It’s good for 15 minutes.`}
        forgotSentText={(email) =>
          `If an account exists for ${email}, we sent a link to choose a password. It’s good for 15 minutes.`
        }
        footer={
          <div style={{ marginTop: 12, fontSize: 12, color: theme.textDim, textAlign: 'center' }}>
            New here?{' '}
            <Link to="/creator/signup" style={{ color: theme.accentText }}>
              Create an account
            </Link>{' '}
            ·{' '}
            <Link to="/" style={{ color: theme.accentText }}>
              Home
            </Link>
          </div>
        }
      />
    </AuthFrame>
  );
}
