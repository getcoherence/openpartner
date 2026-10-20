import { useLocation, useNavigate, useSearchParams } from 'react-router';
import { PlatformFrame } from './components.js';
import { papi } from './lib.js';
import {
  AuthNotice,
  EmailPasswordForm,
  googleStartHref,
  postPlatform,
  useAuthProviders,
  type AuthLocationState,
} from '../auth/PasswordAuth.js';

/**
 * Operator sign-in: Google, the platform password (the same one the person
 * uses at /signin), or an emailed link. Link and reset requests always
 * answer 200 (no account enumeration), so their confirmations read the
 * same whether or not the address is an operator. Password and Google end
 * in POST /auth/platform-admin-verify, like the emailed link.
 */
export function PlatformLoginPage() {
  const nav = useNavigate();
  const [params] = useSearchParams();
  const state = (useLocation().state ?? {}) as AuthLocationState;
  const providers = useAuthProviders();

  return (
    <PlatformFrame title="Operator sign-in" subtitle="OpenPartner staff only.">
      <AuthNotice error={params.get('error')} reset={state.reset} />
      <EmailPasswordForm
        initialEmail={state.email}
        emailPlaceholder="you@openpartner.dev"
        googleHref={providers.googleStartUrl ? googleStartHref(providers.googleStartUrl, 'ops') : null}
        onPassword={async (email, password) => {
          const { token } = await papi<{ token: string }>('/platform-admin/signin/password', {
            method: 'POST',
            body: { email, password },
          });
          await papi('/auth/platform-admin-verify', { method: 'POST', body: { token } });
          nav('/platform/brands', { replace: true });
        }}
        onLink={(email) => papi('/platform-admin/signin', { method: 'POST', body: { email } }).then(() => undefined)}
        onForgot={(email) => postPlatform('/password/forgot', { email, context: 'ops' }).then(() => undefined)}
        linkSentText={() =>
          'If that address belongs to an operator, a sign-in link is on its way. It’s good for a short while — request another from this page if it expires.'
        }
        forgotSentText={() => 'If that address belongs to an operator, a link to choose a password is on its way.'}
      />
    </PlatformFrame>
  );
}
