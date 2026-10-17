import { Box, Divider, Inline, Link, SettingsView } from '@stripe/ui-extension-sdk/ui';
import type { ExtensionContextValue } from '@stripe/ui-extension-sdk/context';

/**
 * The app's settings page in the Stripe Dashboard (Settings → Installed
 * apps → OpenPartner). Everything is configured in OpenPartner itself, so
 * this only says what the app does and links out. It makes no API calls
 * and stores nothing.
 */
const DOCS_URL = 'https://openpartner.dev/docs/stripe-app';
const PORTAL_URL = 'https://app.openpartner.dev';

const AppSettings = (_context: ExtensionContextValue) => (
  <SettingsView>
    <Box css={{ stack: 'y', gap: 'large' }}>
      <Box css={{ stack: 'y', gap: 'small' }}>
        <Inline css={{ font: 'heading' }}>OpenPartner partner attribution</Inline>
        <Inline css={{ font: 'body', color: 'secondary' }}>
          Your Stripe checkouts, invoices, refunds and disputes credit the partner who referred each customer — no
          webhook forwarding from your servers. Partner promo codes are created in this account when a partner
          program offers customers a discount.
        </Inline>
      </Box>
      <Divider />
      <Box css={{ stack: 'y', gap: 'small' }}>
        <Inline css={{ font: 'body' }}>
          Manage the connection in OpenPartner under Admin → Integrations. To stop OpenPartner reading this
          account, disconnect there, or uninstall the app here.
        </Inline>
        <Link href={PORTAL_URL} target="_blank" type="secondary">
          Open OpenPartner
        </Link>
        <Link href={DOCS_URL} target="_blank" type="secondary">
          How the Stripe app works
        </Link>
      </Box>
    </Box>
  </SettingsView>
);

export default AppSettings;
