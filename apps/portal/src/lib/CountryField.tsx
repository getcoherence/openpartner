import { useMemo } from 'react';
import { COUNTRY_CODES, OCCUPIED_REGION_COUNTRY } from '@openpartner/db';
import { theme } from '../theme.js';

/**
 * "Where are you based?" — a country picker plus, for Ukraine, the
 * confirmation that the business is outside the occupied regions. Used by
 * brand signup, add-brand, the partner join page and the one-time prompt
 * for existing brands. Names come from Intl.DisplayNames, so they follow
 * the viewer's language; codes are what the API stores.
 */
export function CountryField({
  value,
  onChange,
  outsideOccupiedRegions,
  onOutsideOccupiedRegionsChange,
  selectStyle,
  id = 'country',
}: {
  value: string;
  onChange: (code: string) => void;
  outsideOccupiedRegions: boolean;
  onOutsideOccupiedRegionsChange: (v: boolean) => void;
  selectStyle?: React.CSSProperties;
  id?: string;
}) {
  const options = useMemo(() => countryOptions(), []);
  return (
    <>
      <select
        id={id}
        name="country"
        autoComplete="country"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        required
        style={selectStyle}
      >
        <option value="" disabled>
          Select a country
        </option>
        {options.map((o) => (
          <option key={o.code} value={o.code}>
            {o.name}
          </option>
        ))}
      </select>
      {value === OCCUPIED_REGION_COUNTRY && (
        <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginTop: 8, fontSize: 12, color: theme.textMuted }}>
          <input
            type="checkbox"
            checked={outsideOccupiedRegions}
            onChange={(e) => onOutsideOccupiedRegionsChange(e.target.checked)}
            required
            style={{ marginTop: 2 }}
          />
          <span>
            I confirm I'm not based in Crimea, Sevastopol, or the Russian-occupied areas of the Donetsk, Luhansk, Kherson
            or Zaporizhzhia regions.
          </span>
        </label>
      )}
    </>
  );
}

export function countryOptions(): Array<{ code: string; name: string }> {
  let names: Intl.DisplayNames | null = null;
  try {
    names = new Intl.DisplayNames(typeof navigator !== 'undefined' ? [navigator.language, 'en'] : ['en'], {
      type: 'region',
    });
  } catch {
    names = null;
  }
  return COUNTRY_CODES.map((code) => ({ code, name: names?.of(code) ?? code })).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
}

export function countryName(code: string): string {
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' }).of(code) ?? code;
  } catch {
    return code;
  }
}

/** The message for a country-access refusal from the API, or null when
 *  the error is something else. Deliberately states no reason. */
export function countryErrorMessage(code: string): string | null {
  if (code.includes('country_not_supported')) return "Sorry — OpenPartner isn't available in your country.";
  if (code.includes('occupied_region_confirmation_required')) {
    return 'Please confirm you are not based in the occupied regions of Ukraine.';
  }
  if (code.includes('country_required')) return 'Select the country where you are based.';
  return null;
}
