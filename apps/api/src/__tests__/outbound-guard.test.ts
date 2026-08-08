/**
 * SSRF guard unit + integration tests. The pre-flight checks (scheme, port,
 * credentials, IP classification, hostname suffixes) run against IP literals
 * so no DNS is needed; a localhost HTTP server exercises the block-vs-allow
 * boundary and confirms a blocked destination never receives a request.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

process.env.OPENPARTNER_MODE = 'selfhost';
process.env.OPENPARTNER_TENANCY = 'single';

const {
  safeFetch,
  __assertAllowedForTests,
  __resetOutboundPolicyForTests,
  OutboundBlockedError,
  outboundPolicy,
} = await import('../outbound-guard.js');

// A permissive policy for the "allowed" assertions that would otherwise need
// real DNS — public IP literals only, any port.
const PUBLIC_POLICY = { allowedPorts: null, privateCidrs: [] as never[] };

async function expectBlocked(url: string, code: string, policy?: Parameters<typeof __assertAllowedForTests>[1]): Promise<void> {
  await expect(__assertAllowedForTests(url, policy)).rejects.toMatchObject({
    name: 'OutboundBlockedError',
    message: code,
  });
}

describe('outbound-guard pre-flight validation', () => {
  it('allows public unicast IPv4/IPv6 literals', async () => {
    await expect(__assertAllowedForTests('https://8.8.8.8/x', PUBLIC_POLICY)).resolves.toBeUndefined();
    await expect(__assertAllowedForTests('https://1.1.1.1/x', PUBLIC_POLICY)).resolves.toBeUndefined();
    await expect(__assertAllowedForTests('https://[2001:4860:4860::8888]/x', PUBLIC_POLICY)).resolves.toBeUndefined();
  });

  it('rejects non-http(s) schemes', async () => {
    await expectBlocked('ftp://8.8.8.8/x', 'scheme_not_allowed', PUBLIC_POLICY);
    await expectBlocked('file:///etc/passwd', 'scheme_not_allowed', PUBLIC_POLICY);
  });

  it('rejects embedded credentials', async () => {
    await expectBlocked('http://user:pass@8.8.8.8/x', 'credentials_not_allowed', PUBLIC_POLICY);
  });

  it('rejects loopback / private / link-local / CGNAT / unspecified', async () => {
    await expectBlocked('http://127.0.0.1/x', 'destination_not_public', PUBLIC_POLICY);
    await expectBlocked('http://10.0.0.5/x', 'destination_not_public', PUBLIC_POLICY);
    await expectBlocked('http://192.168.1.1/x', 'destination_not_public', PUBLIC_POLICY);
    await expectBlocked('http://172.16.0.1/x', 'destination_not_public', PUBLIC_POLICY);
    await expectBlocked('http://169.254.169.254/latest/meta-data/', 'destination_not_public', PUBLIC_POLICY);
    await expectBlocked('http://100.64.0.1/x', 'destination_not_public', PUBLIC_POLICY);
    await expectBlocked('http://0.0.0.0/x', 'destination_not_public', PUBLIC_POLICY);
    await expectBlocked('http://[::1]/x', 'destination_not_public', PUBLIC_POLICY);
    await expectBlocked('http://[fd00::1]/x', 'destination_not_public', PUBLIC_POLICY);
    await expectBlocked('http://[fe80::1]/x', 'destination_not_public', PUBLIC_POLICY);
  });

  it('rejects IPv4-mapped IPv6 loopback', async () => {
    await expectBlocked('http://[::ffff:127.0.0.1]/x', 'destination_not_public', PUBLIC_POLICY);
  });

  it('sees through octal / hex / decimal IPv4 encodings of loopback', async () => {
    // WHATWG URL normalizes these to 127.0.0.1 before we classify.
    await expectBlocked('http://0177.0.0.1/x', 'destination_not_public', PUBLIC_POLICY);
    await expectBlocked('http://0x7f000001/x', 'destination_not_public', PUBLIC_POLICY);
    await expectBlocked('http://2130706433/x', 'destination_not_public', PUBLIC_POLICY);
  });

  it('rejects special-use hostnames without a DNS round-trip', async () => {
    await expectBlocked('http://localhost/x', 'blocked_hostname', PUBLIC_POLICY);
    await expectBlocked('http://foo.local/x', 'blocked_hostname', PUBLIC_POLICY);
    await expectBlocked('http://svc.internal/x', 'blocked_hostname', PUBLIC_POLICY);
    await expectBlocked('http://printer.home.arpa/x', 'blocked_hostname', PUBLIC_POLICY);
    await expectBlocked('http://singlelabel/x', 'blocked_hostname', PUBLIC_POLICY);
  });

  it('enforces the port allowlist when one is set', async () => {
    const policy = { allowedPorts: new Set([80, 443]), privateCidrs: [] as never[] };
    await expectBlocked('http://8.8.8.8:22/x', 'port_not_allowed', policy);
    await expect(__assertAllowedForTests('https://8.8.8.8:443/x', policy)).resolves.toBeUndefined();
  });

  it('honors the private-CIDR escape hatch', async () => {
    const ipaddr = (await import('ipaddr.js')).default;
    const policy = { allowedPorts: null, privateCidrs: [ipaddr.parseCIDR('127.0.0.1/32')] as never[] };
    await expect(__assertAllowedForTests('http://127.0.0.1:9999/x', policy)).resolves.toBeUndefined();
    // A private IP NOT in the allowlist is still blocked.
    await expectBlocked('http://10.1.2.3/x', 'destination_not_public', policy);
  });
});

describe('outboundPolicy env handling', () => {
  it('refuses the private-CIDR hatch outside selfhost+single', async () => {
    __resetOutboundPolicyForTests();
    process.env.OPENPARTNER_MODE = 'flat';
    process.env.OPENPARTNER_OUTBOUND_ALLOW_PRIVATE_CIDRS = '127.0.0.1/32';
    expect(() => outboundPolicy()).toThrow(/selfhost\+single/);
    // restore
    delete process.env.OPENPARTNER_OUTBOUND_ALLOW_PRIVATE_CIDRS;
    process.env.OPENPARTNER_MODE = 'selfhost';
    __resetOutboundPolicyForTests();
  });

  it('defaults hosted deploys to ports 80/443', async () => {
    __resetOutboundPolicyForTests();
    process.env.OPENPARTNER_MODE = 'flat';
    const policy = outboundPolicy();
    expect(policy.allowedPorts && [...policy.allowedPorts].sort((a, b) => a - b)).toEqual([80, 443]);
    process.env.OPENPARTNER_MODE = 'selfhost';
    __resetOutboundPolicyForTests();
  });
});

describe('safeFetch against a live server', () => {
  let server: Server;
  let port = 0;
  let hits = 0;

  beforeAll(async () => {
    await new Promise<void>((resolve) => {
      server = createServer((_req, res) => {
        hits += 1;
        res.statusCode = 204;
        res.end();
      });
      server.listen(0, '127.0.0.1', () => {
        port = (server.address() as AddressInfo).port;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('blocks a private destination BEFORE opening a socket', async () => {
    const before = hits;
    await expect(
      safeFetch(`http://127.0.0.1:${port}/`, {}, { allowedPorts: null, privateCidrs: [] }),
    ).rejects.toBeInstanceOf(OutboundBlockedError);
    expect(hits).toBe(before); // never connected
  });

  it('reaches a destination explicitly allowed via the escape hatch', async () => {
    const ipaddr = (await import('ipaddr.js')).default;
    const before = hits;
    const res = await safeFetch(
      `http://127.0.0.1:${port}/`,
      {},
      { allowedPorts: null, privateCidrs: [ipaddr.parseCIDR('127.0.0.1/32')] },
    );
    expect(res.status).toBe(204);
    expect(res.ok).toBe(true); // 204 is within 200–299
    expect(hits).toBe(before + 1);
  });
});
