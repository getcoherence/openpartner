import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api.js';
import { Button, Card, ErrorBanner, Label, Select, Textarea } from '../../ui.js';
import { theme } from '../../theme.js';

interface ConnectSettings {
  accountMode: 'standard' | 'custom_payouts';
  collectTaxInformation: boolean;
  requestCardPayments: boolean;
  collect1099KTaxInformation: boolean;
  collectEventuallyDue: boolean;
  collectFutureRequirements: boolean;
  productDescription: string;
}

export function StripeConnectSettingsSection() {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: ['stripe-connect-settings'],
    queryFn: () => api<ConnectSettings>('/config/stripe-connect'),
  });
  const [draft, setDraft] = useState<ConnectSettings | null>(null);
  const [saved, setSaved] = useState(false);
  const settings = draft ?? query.data;
  const save = useMutation({
    mutationFn: (body: ConnectSettings) => api<ConnectSettings>('/config/stripe-connect', { method: 'POST', body }),
    onSuccess: (data) => {
      qc.setQueryData(['stripe-connect-settings'], data);
      qc.invalidateQueries({ queryKey: ['connect-status'] });
      setDraft(null);
      setSaved(true);
    },
  });
  function change(patch: Partial<ConnectSettings>) {
    if (settings) setDraft({ ...settings, ...patch });
    setSaved(false);
  }

  return (
    <Card>
      <div style={{ fontSize: 15, fontWeight: 500, marginBottom: 12 }}>Stripe Connect account setup</div>
      <ErrorBanner error={query.error ?? save.error} />
      {query.isLoading ? <p>Loading…</p> : settings && (
        <fieldset disabled={save.isPending} style={{ border: 0, padding: 0, margin: 0, maxWidth: 640 }}>
          <Label htmlFor="stripe-account-mode">Accounts for new partners</Label>
          <Select id="stripe-account-mode" value={settings.accountMode}
            onChange={(e) => change({ accountMode: e.target.value as ConnectSettings['accountMode'] })}>
            <option value="standard">Standard accounts (default)</option>
            <option value="custom_payouts">Custom accounts (configurable)</option>
          </Select>
          <p style={{ fontSize: 13, color: theme.textMuted, lineHeight: 1.6 }}>
            {settings.accountMode === 'standard'
              ? 'Partners onboard with Stripe and get a full Stripe dashboard. Stripe manages their account requirements. Partners may be asked for more business information, such as a website and the products or services they sell.'
              : 'Partners onboard without their own Stripe dashboard. Choose the capabilities and information collection your program needs below. Your business takes responsibility for connected-account requirements and losses. Additional Stripe Connect fees apply.'}
          </p>
          {settings.accountMode === 'custom_payouts' && (
            <div style={{ display: 'grid', gap: 14, marginBottom: 16 }}>
              <p style={{ fontSize: 13, color: theme.textMuted, margin: 0 }}>
                These options expand a Custom account’s capabilities. They do not give it Standard’s dashboard,
                pricing, or verification responsibilities. Choose Standard above for that setup.
              </p>
              <label style={{ fontSize: 13 }}>
                <input type="checkbox" checked disabled readOnly />{' '}
                Receive transfers (required for affiliate payouts)
              </label>
              <label style={{ fontSize: 13 }}>
                <input type="checkbox" checked={settings.requestCardPayments}
                  onChange={(e) => change({ requestCardPayments: e.target.checked })} />{' '}
                Request card payments
                <span style={{ display: 'block', color: theme.textMuted, marginTop: 4 }}>
                  Use if partners also need to accept customer payments. Stripe may ask for more business
                  information, including a website and products sold. Collecting payments requires a separate
                  payment integration; this setting only requests the account capability.
                </span>
              </label>
              <label style={{ fontSize: 13 }}>
                <input type="checkbox" checked={settings.collectTaxInformation}
                  onChange={(e) => change({ collectTaxInformation: e.target.checked })} />{' '}
                Collect US tax-reporting information (1099-MISC capability)
                <span style={{ display: 'block', color: theme.textMuted, marginTop: 4 }}>
                  Requests US 1099 tax information from Stripe. Enable only when applicable to your program.
                  This does not file tax forms or guarantee that a complete tax ID has been collected.
                </span>
              </label>
              <label style={{ fontSize: 13 }}>
                <input type="checkbox" checked={settings.collect1099KTaxInformation}
                  onChange={(e) => change({ collect1099KTaxInformation: e.target.checked })} />{' '}
                Collect US 1099-K tax information
                <span style={{ display: 'block', color: theme.textMuted, marginTop: 4 }}>
                  For programs with applicable payment-reporting requirements. This is a separate capability;
                  it does not file a 1099-K or select the correct tax form for your business.
                </span>
              </label>
              <label style={{ fontSize: 13 }}>
                <input type="checkbox" checked={settings.collectEventuallyDue}
                  onChange={(e) => change({ collectEventuallyDue: e.target.checked })} />{' '}
                Collect all known verification requirements upfront
                <span style={{ display: 'block', color: theme.textMuted, marginTop: 4 }}>
                  Includes details Stripe would otherwise request later. Uncheck to collect only what is currently due.
                </span>
              </label>
              <label style={{ fontSize: 13 }}>
                <input type="checkbox" checked={settings.collectFutureRequirements}
                  onChange={(e) => change({ collectFutureRequirements: e.target.checked })} />{' '}
                Include upcoming verification changes
                <span style={{ display: 'block', color: theme.textMuted, marginTop: 4 }}>
                  Collect additional information Stripe already lists for upcoming requirement changes.
                  This is separate from details that become due as a partner earns more.
                </span>
              </label>
              <div>
                <Label htmlFor="stripe-activity-description">Affiliate activity description</Label>
                <Textarea id="stripe-activity-description" value={settings.productDescription} maxLength={500}
                  onChange={(e) => change({ productDescription: e.target.value })} />
                <p style={{ fontSize: 13, color: theme.textMuted }}>
                  Prefilled for new accounts. Describe your partners’ actual activity. Leave blank to let Stripe ask.
                </p>
              </div>
              <p style={{ fontSize: 13, color: theme.textMuted, margin: 0 }}>
                Custom accounts use your Stripe platform’s country and the full service agreement.
                Complete your Stripe Connect platform profile before using this option.
              </p>
              <details style={{ fontSize: 13, color: theme.textMuted, lineHeight: 1.6 }}>
                <summary style={{ cursor: 'pointer' }}>Other Stripe configuration options</summary>
                <p>
                  Stripe also supports Express dashboards, additional payment methods, bank payout schedules,
                  branding, and public business details. These have their own eligibility and integration requirements;
                  they are not all independent Custom-account checkboxes.
                </p>
                <p>
                  Website, address, and tax-ID requirements are determined by Stripe for the account’s country,
                  business type, and capabilities. These settings cannot switch required checks off.
                </p>
                <a href="https://dashboard.stripe.com/settings/connect/onboarding-options/public-details" target="_blank" rel="noreferrer" style={{ color: theme.accentText }}>
                  Configure optional public details in Stripe
                </a>{' · '}
                <a href="https://docs.stripe.com/connect/account-capabilities" target="_blank" rel="noreferrer" style={{ color: theme.accentText }}>
                  Full Stripe capability reference
                </a>
              </details>
            </div>
          )}
          <p style={{ fontSize: 13, color: theme.textMuted, lineHeight: 1.6 }}>
            Account type, capabilities, and description apply to newly created accounts only.
            Existing accounts remain linked with their original type and capabilities.
            The verification collection options also apply when existing Custom accounts resume onboarding.
          </p>
          <p style={{ fontSize: 13 }}>
            <a href="https://stripe.com/connect/pricing" target="_blank" rel="noreferrer" style={{ color: theme.accentText }}>
              Review Stripe Connect pricing
            </a>
          </p>
          <Button onClick={() => save.mutate(settings)} disabled={!draft || save.isPending}>
            {save.isPending ? 'Saving…' : 'Save Stripe settings'}
          </Button>
          {saved && <span role="status" style={{ marginLeft: 12, color: theme.success, fontSize: 13 }}>Saved.</span>}
        </fieldset>
      )}
    </Card>
  );
}
