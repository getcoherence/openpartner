/**
 * DO App Platform domain automation — pure spec read-modify-write logic.
 *
 * The invariant that matters: mutations touch ONLY the target domain entry
 * and preserve everything else in the spec verbatim (services, envs, the
 * PRIMARY platform domain with its DO-managed zone). Clobbering any of
 * those in the PUT would take down the whole app, not just one customer.
 */

import { describe, expect, it } from 'vitest';
import { addDomainToSpec, removeDomainFromSpec, type DoAppSpec } from '../do-app-domains.js';

const baseSpec = (): DoAppSpec => ({
  name: 'openpartner',
  region: 'nyc',
  services: [{ name: 'api' }],
  domains: [{ domain: 'app.openpartner.dev', type: 'PRIMARY', zone: 'openpartner.dev' }],
});

describe('addDomainToSpec', () => {
  it('appends the customer domain as a zoneless ALIAS, preserving the rest', () => {
    const { spec, changed } = addDomainToSpec(baseSpec(), 'portal.xispark.com');
    expect(changed).toBe(true);
    expect(spec.domains).toEqual([
      { domain: 'app.openpartner.dev', type: 'PRIMARY', zone: 'openpartner.dev' },
      { domain: 'portal.xispark.com', type: 'ALIAS' },
    ]);
    expect(spec.name).toBe('openpartner');
    expect(spec.services).toEqual([{ name: 'api' }]);
  });

  it('is idempotent — an existing domain (any case) is not duplicated', () => {
    const withDomain = addDomainToSpec(baseSpec(), 'portal.xispark.com').spec;
    const again = addDomainToSpec(withDomain, 'portal.xispark.com');
    expect(again.changed).toBe(false);
    const upper = { ...withDomain, domains: [{ domain: 'Portal.Xispark.Com' }] };
    expect(addDomainToSpec(upper, 'portal.xispark.com').changed).toBe(false);
  });

  it('handles a spec with no domains list at all', () => {
    const { spec, changed } = addDomainToSpec({ name: 'openpartner' }, 'portal.xispark.com');
    expect(changed).toBe(true);
    expect(spec.domains).toEqual([{ domain: 'portal.xispark.com', type: 'ALIAS' }]);
  });
});

describe('removeDomainFromSpec', () => {
  it('removes only the target domain, never the PRIMARY platform domain', () => {
    const withDomain = addDomainToSpec(baseSpec(), 'portal.xispark.com').spec;
    const { spec, changed } = removeDomainFromSpec(withDomain, 'portal.xispark.com');
    expect(changed).toBe(true);
    expect(spec.domains).toEqual([
      { domain: 'app.openpartner.dev', type: 'PRIMARY', zone: 'openpartner.dev' },
    ]);
  });

  it('reports unchanged when the domain is not present', () => {
    const { changed } = removeDomainFromSpec(baseSpec(), 'portal.xispark.com');
    expect(changed).toBe(false);
  });
});
