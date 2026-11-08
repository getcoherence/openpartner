import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CreditCard } from 'lucide-react';
import { api } from '../../api.js';
import { Button, Card, ErrorBanner, Label, Select, Textarea } from '../../ui.js';
import { theme } from '../../theme.js';

interface ConnectSettings {
  accountMode: 'standard' | 'custom_payouts';
  collectTaxInformation: boolean;
  collect1099KTaxInformation: boolean;
  collectEventuallyDue: boolean;
  collectFutureRequirements: boolean;
  productDescription: string;
}

type ConnectSettingsResponse = ConnectSettings & {
  /** Only self-hosted instances can choose Custom accounts. */
  customAccountsAvailable: boolean;
};

export function useStripeConnectSettings() {
  return useQuery({
    queryKey: ['stripe-connect-settings'],
    queryFn: () => api<ConnectSettingsResponse>('/config/stripe-connect'),
  });
}

export function StripeConnectSettingsSection() {
  const qc = useQueryClient();
  const query = useStripeConnectSettings();
  const [draft, setDraft] = useState<ConnectSettings | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (!saved) return;
    const timer = setTimeout(() => setSaved(false), 2000);
    return () => clearTimeout(timer);
  }, [saved]);
  const settings: ConnectSettings | undefined = draft ?? (query.data && withoutAvailability(query.data));
  const save = useMutation({
    mutationFn: (body: ConnectSettings) => api<ConnectSettingsResponse>('/config/stripe-connect', { method: 'POST', body }),
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

  if (query.isLoading) return <Card>Loading…</Card>;

  return (
    <Card>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
        <CreditCard size={18} style={{ color: theme.accentText }} />
        <div style={{ fontSize: 15, fontWeight: 500 }}>Stripe Connect account setup</div>
      </div>
      <ErrorBanner error={query.error ?? save.error} />
      {settings && (
        <fieldset disabled={save.isPending} style={{ border: 0, padding: 0, margin: 0, minWidth: 0, maxWidth: 640 }}>
          <Label htmlFor="stripe-account-mode">Accounts for new partners</Label>
          <Select id="stripe-account-mode" value={settings.accountMode}
            onChange={(e) => change({ accountMode: e.target.value as ConnectSettings['accountMode'] })}>
            <option value="standard">Standard accounts (default)</option>
            <option value="custom_payouts">Custom accounts</option>
          </Select>
          {settings.accountMode === 'custom_payouts' && (
            <div style={{ display: 'grid', gap: 10, margin: '12px 0 16px' }}>
              <label style={{ fontSize: 13 }}>
                <input type="checkbox" checked disabled readOnly /> Receive transfers (required)
              </label>
              <label style={{ fontSize: 13 }}>
                <input type="checkbox" checked={settings.collectTaxInformation}
                  onChange={(e) => change({ collectTaxInformation: e.target.checked })} /> Collect US 1099-MISC tax information
              </label>
              <label style={{ fontSize: 13 }}>
                <input type="checkbox" checked={settings.collect1099KTaxInformation}
                  onChange={(e) => change({ collect1099KTaxInformation: e.target.checked })} /> Collect US 1099-K tax information
              </label>
              <label style={{ fontSize: 13 }}>
                <input type="checkbox" checked={settings.collectEventuallyDue}
                  onChange={(e) => change({ collectEventuallyDue: e.target.checked })} /> Collect all known verification requirements upfront
              </label>
              <label style={{ fontSize: 13 }}>
                <input type="checkbox" checked={settings.collectFutureRequirements}
                  onChange={(e) => change({ collectFutureRequirements: e.target.checked })} /> Include upcoming verification changes
              </label>
              <div>
                <Label htmlFor="stripe-activity-description">Affiliate activity description</Label>
                <Textarea id="stripe-activity-description" value={settings.productDescription} maxLength={500}
                  onChange={(e) => change({ productDescription: e.target.value })} />
              </div>
            </div>
          )}
          <p style={{ fontSize: 13 }}>
            <a href="https://docs.stripe.com/connect/account-capabilities" target="_blank" rel="noreferrer" style={{ color: theme.accentText }}>
              Stripe account capabilities
            </a>
          </p>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <Button onClick={() => save.mutate(settings)} disabled={!draft || save.isPending}>
              {save.isPending ? 'Saving…' : 'Save Stripe settings'}
            </Button>
            {saved && <span role="status" style={{ color: theme.success, fontSize: 13 }}>Saved.</span>}
          </div>
        </fieldset>
      )}
    </Card>
  );
}

function withoutAvailability({ customAccountsAvailable: _, ...settings }: ConnectSettingsResponse): ConnectSettings {
  return settings;
}
