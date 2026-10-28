/**
 * GET /consent-region, the browser SDK's consent rule lookup for
 * `consent: 'regional'` (consent-region.ts): the rule by country, an
 * unknown country as opt-in, the tenant-prefixed form the SDK actually
 * calls, no caching, and CORS open to any origin without credentials.
 * The IP lookup is stubbed; no database is touched.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';

process.env.OPENPARTNER_TENANCY = 'multi';
process.env.OPENPARTNER_MODE = 'revshare';

const { createApp } = await import('../app.js');
const { setIpCountryLookupForTesting } = await import('../geoip.js');
const { OPT_IN_COUNTRIES, consentRuleFor } = await import('../consent-region.js');
const app = createApp({ enableLogger: false });

let country: string | null = null;
beforeEach(() => {
  country = null;
  setIpCountryLookupForTesting(async () => country);
});
afterAll(() => setIpCountryLookupForTesting(null));

describe('GET /consent-region', () => {
  it('asks first in the EU, the rest of the EEA, the UK and Switzerland, and nowhere else', async () => {
    for (const [c, rule] of [
      ['DE', 'opt_in'],
      ['FR', 'opt_in'],
      ['NO', 'opt_in'],
      ['GB', 'opt_in'],
      ['CH', 'opt_in'],
      ['US', 'opt_out'],
      ['IN', 'opt_out'],
      ['BR', 'opt_out'],
    ] as const) {
      country = c;
      const res = await request(app).get('/consent-region');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ rule, country: c });
    }
  });

  it('asks first when the country is unknown, whatever headers the client sends', async () => {
    const res = await request(app).get('/consent-region').set('cf-ipcountry', 'US');
    expect(res.body).toEqual({ rule: 'opt_in', country: null });
  });

  it('answers under the SDK’s apiUrl, tenant prefix and all, without needing the tenant', async () => {
    country = 'US';
    for (const path of ['/t/openpartner/consent-region', '/api/t/no-such-brand/consent-region', '/consent-region/']) {
      const res = await request(app).get(path);
      expect(res.status, path).toBe(200);
      expect(res.body.rule).toBe('opt_out');
    }
  });

  it('is never cached, and any origin can read it without credentials', async () => {
    const res = await request(app).get('/t/openpartner/consent-region').set('Origin', 'https://openpartner.dev');
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.headers['access-control-allow-origin']).toBe('https://openpartner.dev');
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
  });
});

describe('the opt-in list', () => {
  it('holds the 27 EU states, Iceland, Liechtenstein, Norway, the UK and Switzerland', () => {
    const eu = ['AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE'];
    expect(eu).toHaveLength(27);
    for (const c of [...eu, 'IS', 'LI', 'NO', 'GB', 'CH']) expect(OPT_IN_COUNTRIES.has(c), c).toBe(true);
    expect(consentRuleFor('de')).toBe('opt_in');
    expect(consentRuleFor(null)).toBe('opt_in');
    expect(consentRuleFor('CA')).toBe('opt_out');
  });
});
