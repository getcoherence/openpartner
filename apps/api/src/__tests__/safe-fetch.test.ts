/**
 * safeFetch: SSRF guard on outbound Network calls.
 *
 * We can't cheaply test a real fetch without a network, so this file
 * exercises the protocol + hostname validation that safeFetch does
 * BEFORE calling fetch. Runs under NODE_ENV=production to skip the
 * test-env bypass baked into the guard.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { safeFetch } from '../network/safe-fetch.js';

describe('safeFetch SSRF guard', () => {
  const original = process.env.NODE_ENV;
  beforeEach(() => {
    process.env.NODE_ENV = 'production';
    delete process.env.NETWORK_ALLOW_PRIVATE_HOSTS;
  });
  afterEach(() => {
    process.env.NODE_ENV = original;
  });

  it('rejects non-http(s) protocols', async () => {
    await expect(safeFetch('file:///etc/passwd')).rejects.toMatchObject({ code: 'unsupported_protocol' });
    await expect(safeFetch('gopher://example.com/')).rejects.toMatchObject({ code: 'unsupported_protocol' });
  });

  it('rejects IPv4 loopback / private ranges by literal IP', async () => {
    await expect(safeFetch('http://127.0.0.1/')).rejects.toMatchObject({ code: 'private_host_blocked' });
    await expect(safeFetch('http://10.0.0.1/')).rejects.toMatchObject({ code: 'private_host_blocked' });
    await expect(safeFetch('http://192.168.1.1/')).rejects.toMatchObject({ code: 'private_host_blocked' });
    await expect(safeFetch('http://169.254.169.254/latest/meta-data/')).rejects.toMatchObject({
      code: 'private_host_blocked',
    });
    await expect(safeFetch('http://172.16.0.1/')).rejects.toMatchObject({ code: 'private_host_blocked' });
  });

  it('rejects IPv6 loopback / link-local / unique-local', async () => {
    await expect(safeFetch('http://[::1]/')).rejects.toMatchObject({ code: 'private_host_blocked' });
    await expect(safeFetch('http://[fe80::1]/')).rejects.toMatchObject({ code: 'private_host_blocked' });
    await expect(safeFetch('http://[fc00::1]/')).rejects.toMatchObject({ code: 'private_host_blocked' });
  });

  it('rejects hostnames that resolve to loopback (localhost)', async () => {
    // localhost normally resolves to 127.0.0.1 or ::1 via the hosts file.
    await expect(safeFetch('http://localhost/')).rejects.toMatchObject({ code: 'private_host_blocked' });
  });

  it('opts out of the guard when NETWORK_ALLOW_PRIVATE_HOSTS=1', async () => {
    process.env.NETWORK_ALLOW_PRIVATE_HOSTS = '1';
    // We still expect the request itself to fail (nothing listening at
    // this port in the test env), but NOT with private_host_blocked.
    await expect(safeFetch('http://127.0.0.1:59999/', { signal: AbortSignal.timeout(200) })).rejects.not.toMatchObject(
      { code: 'private_host_blocked' },
    );
  });
});
