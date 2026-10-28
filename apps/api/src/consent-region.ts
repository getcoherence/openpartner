/**
 * Which consent rule applies to a visitor, by the country their IP address
 * is in. The browser SDK's `consent: 'regional'` mode asks for it (GET
 * /consent-region, routes/consent-region.ts) before it reads or writes
 * anything:
 *
 *   opt_in   ask first: the SDK waits for setConsent('granted'), as with
 *            'pending'. The countries below, and every visitor whose
 *            country isn't known.
 *   opt_out  track unless the visitor declines: the SDK starts as
 *            'granted' unless setConsent('denied') came first.
 *
 * OPT_IN_COUNTRIES is the one list. It covers where partner-referral cookies
 * need prior consent under the ePrivacy rules: the EU (with the overseas
 * parts that have their own ISO codes), the rest of the EEA, the UK and
 * Switzerland. Anything that should ask first goes here. For v1 it's a code
 * constant for every program. A brand-editable list would belong in the
 * Config table with an admin setting, never in env.
 *
 * Country comes from the API's own IP lookup (geoip.ts), not Cloudflare's
 * cf-ipcountry: DO App Platform doesn't forward that header.
 */

export type ConsentRule = 'opt_in' | 'opt_out';

export const OPT_IN_COUNTRIES: ReadonlySet<string> = new Set([
  // EU member states
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE',
  'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
  // EU territory with its own ISO code (Åland, the French outermost regions)
  'AX', 'GF', 'GP', 'MQ', 'RE', 'YT', 'MF',
  // The rest of the EEA
  'IS', 'LI', 'NO',
  // The UK and Switzerland
  'GB', 'CH',
]);

export function consentRuleFor(country: string | null): ConsentRule {
  if (!country) return 'opt_in';
  return OPT_IN_COUNTRIES.has(country.toUpperCase()) ? 'opt_in' : 'opt_out';
}
