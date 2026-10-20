import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { theme } from '../../theme.js';
import { Button, Card, ErrorBanner, Page, Table } from '../../ui.js';
import { countryName, countryOptions } from '../../lib/CountryField.js';
import { papi, friendlyPlatformError, type PlatformOperator } from './lib.js';

type Basis = 'sanctions' | 'policy';
interface BlockedCountry {
  code: string;
  basis: Basis;
}
/** The Network's copy of the list, which it checks creators against. */
type NetworkCopy =
  | { configured: false }
  | {
      configured: true;
      ok: true;
      syncedAt: string | null;
      updatedByEmail: string | null;
      matches: boolean;
      creatorsWithoutCountry: number | null;
    }
  | { configured: true; ok: false; error: string; detail: string };
type NetworkPush =
  | { status: 'synced'; syncedAt: string | null }
  | { status: 'not_configured' }
  | { status: 'failed'; error: string; detail: string };
interface CountryAccessState {
  settings: { enforce: boolean; blocked: BlockedCountry[] };
  defaults: { enforce: boolean; blocked: BlockedCountry[] };
  brandsWithoutCountry: number;
  geoip: 'configured' | 'db-ip-lite';
  network: NetworkCopy;
}

const BASIS_LABEL: Record<Basis, string> = {
  sanctions: 'US sanctions',
  policy: 'Company policy',
};

/**
 * Countries the hosted platform doesn't serve. Signup, partner join and
 * every sign-in check both the country a brand or partner declares and the
 * country the request comes from. "US sanctions" entries follow the law;
 * "Company policy" entries are our own choice — kept apart so nobody
 * describes one as the other. The Network applies the same list to
 * creators from its own copy, pushed on every save and daily.
 */
export function CountriesPage({ operator }: { operator: PlatformOperator }) {
  const canWrite = operator.role === 'admin';
  const qc = useQueryClient();
  const state = useQuery({
    queryKey: ['platform-country-access'],
    queryFn: () => papi<CountryAccessState>('/platform-admin/country-access'),
  });
  const save = useMutation({
    mutationFn: (patch: Partial<CountryAccessState['settings']>) =>
      papi<{ settings: CountryAccessState['settings']; network: NetworkPush }>('/platform-admin/country-access', {
        method: 'PUT',
        body: patch,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['platform-country-access'] }),
  });
  const push = useMutation({
    mutationFn: () => papi<{ network: NetworkPush }>('/platform-admin/country-access/push', { method: 'POST' }),
    onSettled: () => qc.invalidateQueries({ queryKey: ['platform-country-access'] }),
  });
  // Saved here but not on the Network: say so. The daily re-push retries.
  const lastPush = save.data?.network;
  const pushFailed = lastPush?.status === 'failed' && !push.isSuccess ? lastPush : null;
  const [addCode, setAddCode] = useState('');
  const [addBasis, setAddBasis] = useState<Basis>('sanctions');
  const options = useMemo(() => countryOptions(), []);

  const settings = state.data?.settings;
  const blocked = settings?.blocked ?? [];
  const blockedCodes = new Set(blocked.map((b) => b.code));
  const sorted = [...blocked].sort((a, b) =>
    a.basis === b.basis ? countryName(a.code).localeCompare(countryName(b.code)) : a.basis === 'sanctions' ? -1 : 1,
  );

  return (
    <Page
      title="Countries"
      subtitle="Where the hosted platform and the Network don't serve brands, partners or creators. Checked at signup, partner join and every sign-in — against the country they declare and where the request comes from."
    >
      <ErrorBanner
        error={
          save.error
            ? friendlyPlatformError(save.error)
            : push.error
              ? `Couldn't push the list to the Network: ${friendlyPlatformError(push.error)}`
              : pushFailed
                ? `Saved, but the Network didn't get the change (${pushFailed.error}). It's re-sent daily, or push it now below.`
                : state.error
        }
      />
      {state.isLoading || !state.data || !settings ? (
        <Card>Loading…</Card>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <Card>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 15, fontWeight: 600 }}>Enforcement</span>
                  <span
                    style={{
                      fontSize: 11,
                      fontWeight: 600,
                      padding: '3px 9px',
                      borderRadius: 999,
                      color: settings.enforce ? theme.success : theme.warn,
                      background: settings.enforce ? theme.successSoft : theme.surface2,
                    }}
                  >
                    {settings.enforce ? 'on' : 'off — nobody is refused'}
                  </span>
                </div>
                <div style={{ fontSize: 13, color: theme.textMuted, marginTop: 6, lineHeight: 1.5 }}>
                  Turning this off lets everyone in. Locations are still recorded. Only turn it off to recover from a
                  misconfiguration.
                </div>
                <div style={{ fontSize: 12, color: theme.textDim, marginTop: 6 }}>
                  {state.data.brandsWithoutCountry} brand{state.data.brandsWithoutCountry === 1 ? '' : 's'} haven't said
                  where they're based yet; they're asked on their next sign-in. IP geolocation:{' '}
                  {state.data.geoip === 'configured' ? (
                    'configured database'
                  ) : (
                    <>
                      <a href="https://db-ip.com" target="_blank" rel="noreferrer" style={{ color: theme.accentText }}>
                        IP Geolocation by DB-IP
                      </a>{' '}
                      (CC BY 4.0)
                    </>
                  )}
                  .
                </div>
              </div>
              {canWrite && (
                <Button
                  variant={settings.enforce ? 'secondary' : 'primary'}
                  disabled={save.isPending}
                  onClick={() => save.mutate({ enforce: !settings.enforce })}
                >
                  {settings.enforce ? 'Turn off' : 'Turn on'}
                </Button>
              )}
            </div>
          </Card>

          <NetworkCopyCard
            network={state.data.network}
            canWrite={canWrite}
            pushing={push.isPending}
            onPush={() => push.mutate()}
          />

          <Card>
            <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 10 }}>Not served</div>
            <Table
              columns={['Country', 'Why', '']}
              empty="No countries blocked."
              rows={sorted.map((b) => [
                <span key="n">
                  {countryName(b.code)} <span style={{ color: theme.textDim, fontFamily: theme.fontMono }}>{b.code}</span>
                </span>,
                <span key="b" style={{ color: b.basis === 'sanctions' ? theme.text : theme.textMuted }}>
                  {BASIS_LABEL[b.basis]}
                </span>,
                canWrite ? (
                  <Button
                    key="r"
                    size="sm"
                    variant="secondary"
                    disabled={save.isPending}
                    onClick={() => save.mutate({ blocked: blocked.filter((x) => x.code !== b.code) })}
                  >
                    Remove
                  </Button>
                ) : (
                  <span key="r" />
                ),
              ])}
            />
            <div style={{ fontSize: 12, color: theme.textDim, marginTop: 10, lineHeight: 1.5 }}>
              Ukraine isn't listed: Ukrainian brands and partners confirm they're outside Crimea, Sevastopol and the
              occupied areas of Donetsk, Luhansk, Kherson and Zaporizhzhia, which no country code covers.
            </div>
            {canWrite && (
              <form
                style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 14 }}
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!addCode || blockedCodes.has(addCode)) return;
                  save.mutate(
                    { blocked: [...blocked, { code: addCode, basis: addBasis }] },
                    { onSuccess: () => setAddCode('') },
                  );
                }}
              >
                <select value={addCode} onChange={(e) => setAddCode(e.target.value)} style={selectStyle} aria-label="Country">
                  <option value="">Add a country…</option>
                  {options
                    .filter((o) => !blockedCodes.has(o.code))
                    .map((o) => (
                      <option key={o.code} value={o.code}>
                        {o.name}
                      </option>
                    ))}
                </select>
                <select
                  value={addBasis}
                  onChange={(e) => setAddBasis(e.target.value as Basis)}
                  style={selectStyle}
                  aria-label="Why"
                >
                  <option value="sanctions">{BASIS_LABEL.sanctions}</option>
                  <option value="policy">{BASIS_LABEL.policy}</option>
                </select>
                <Button type="submit" disabled={!addCode || save.isPending}>
                  Add
                </Button>
              </form>
            )}
          </Card>
        </div>
      )}
    </Page>
  );
}

/** Whether the Network, which checks creators, has this list. */
function NetworkCopyCard({
  network,
  canWrite,
  pushing,
  onPush,
}: {
  network: NetworkCopy | undefined;
  canWrite: boolean;
  pushing: boolean;
  onPush: () => void;
}) {
  let label: string;
  let tone: 'ok' | 'warn' | 'off';
  let body: React.ReactNode;
  if (!network || !network.configured) {
    label = 'not connected';
    tone = 'off';
    body = "NETWORK_URL and NETWORK_ADMIN_API_KEY aren't both set, so this list isn't sent to the Network.";
  } else if (!network.ok) {
    label = 'unknown';
    tone = 'warn';
    body =
      network.error === 'not_supported'
        ? "This Network doesn't check creators' countries yet. Push the list once it has been updated."
        : `Couldn't read the Network's copy: ${network.detail}`;
  } else if (network.syncedAt === null) {
    label = 'never pushed';
    tone = 'warn';
    body = 'Until it gets this list, the Network applies its own US sanctions defaults.';
  } else {
    label = network.matches ? 'in sync' : 'out of sync';
    tone = network.matches ? 'ok' : 'warn';
    body = (
      <>
        {network.matches ? 'It has this list.' : 'It has a different copy: push it now, or wait for the daily re-send.'}{' '}
        Last pushed {new Date(network.syncedAt).toLocaleString()}
        {network.updatedByEmail ? `, as saved by ${network.updatedByEmail}` : ''}.
      </>
    );
  }
  const badge =
    tone === 'ok'
      ? { color: theme.success, background: theme.successSoft }
      : tone === 'warn'
        ? { color: theme.warn, background: theme.surface2 }
        : { color: theme.textMuted, background: theme.surface2 };
  const undeclared = network?.configured && network.ok ? network.creatorsWithoutCountry : null;
  return (
    <Card>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 15, fontWeight: 600 }}>Network</span>
            <span style={{ fontSize: 11, fontWeight: 600, padding: '3px 9px', borderRadius: 999, ...badge }}>{label}</span>
          </div>
          <div style={{ fontSize: 13, color: theme.textMuted, marginTop: 6, lineHeight: 1.5 }}>
            The Network checks creators against its own copy of this list, sent on every change here and again daily.{' '}
            {body}
          </div>
          {undeclared !== null && (
            <div style={{ fontSize: 12, color: theme.textDim, marginTop: 6 }}>
              {undeclared} creator{undeclared === 1 ? '' : 's'} haven't said where they're based yet; they're asked on
              their next visit.
            </div>
          )}
        </div>
        {canWrite && network?.configured && (
          <Button variant="secondary" disabled={pushing} onClick={onPush}>
            {pushing ? 'Pushing…' : 'Push now'}
          </Button>
        )}
      </div>
    </Card>
  );
}

const selectStyle: React.CSSProperties = {
  padding: '8px 10px',
  fontSize: 13,
  background: theme.surface2,
  border: `1px solid ${theme.border}`,
  borderRadius: theme.radiusSm,
  color: theme.text,
  minWidth: 0,
};
