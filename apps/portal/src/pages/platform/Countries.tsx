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
interface CountryAccessState {
  settings: { enforce: boolean; blocked: BlockedCountry[] };
  defaults: { enforce: boolean; blocked: BlockedCountry[] };
  brandsWithoutCountry: number;
  geoip: 'configured' | 'db-ip-lite';
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
 * describes one as the other.
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
      papi<{ settings: CountryAccessState['settings'] }>('/platform-admin/country-access', { method: 'PUT', body: patch }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['platform-country-access'] }),
  });
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
      subtitle="Where the hosted platform doesn't serve brands or partners. Checked at signup, partner join and every sign-in — against the country they declare and where the request comes from."
    >
      <ErrorBanner error={save.error ? friendlyPlatformError(save.error) : state.error} />
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

const selectStyle: React.CSSProperties = {
  padding: '8px 10px',
  fontSize: 13,
  background: theme.surface2,
  border: `1px solid ${theme.border}`,
  borderRadius: theme.radiusSm,
  color: theme.text,
  minWidth: 0,
};
