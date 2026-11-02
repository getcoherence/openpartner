/**
 * TRUST_PROXY=cloudflare (packages/db/src/trusted-proxy.ts): which
 * X-Forwarded-For entry is the visitor when Cloudflare sits in front of App
 * Platform's ingress, and that nothing a client sends moves it. The chains
 * below are what the app receives; the ingress appends the address it saw
 * as the last entry, and Cloudflare appends whoever connected to it.
 */

import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { forwardedClientAddress, isCloudflareAddress, trustProxyFromEnv } from '@openpartner/db';

const INGRESS = '::ffff:100.127.4.9';
const EDGE = '172.71.30.204';
const VISITOR = '203.0.113.7';
const ATTACKER = '198.51.100.9';
const FORGED = '192.0.2.1';

describe('isCloudflareAddress', () => {
  it("matches Cloudflare's published IPv4 and IPv6 ranges", () => {
    for (const addr of ['172.71.30.204', '162.158.12.1', '104.23.240.9', '173.245.48.1', '131.0.75.255']) {
      expect(isCloudflareAddress(addr), addr).toBe(true);
    }
    for (const addr of ['2a06:98c0:3600::103', '2606:4700:10::6816:1', '2c0f:f248:ffff::1']) {
      expect(isCloudflareAddress(addr), addr).toBe(true);
    }
    expect(isCloudflareAddress('::ffff:172.71.30.204')).toBe(true);
  });

  it('rejects everything else', () => {
    for (const addr of [VISITOR, ATTACKER, '10.244.0.5', '100.127.4.9', '127.0.0.1', '104.28.0.1', '2001:db8::1']) {
      expect(isCloudflareAddress(addr), addr).toBe(false);
    }
  });

  it("doesn't read loose IPv4 forms or junk as a Cloudflare address", () => {
    // 2890342092 and 0xac.71.30.204 are both 172.71.30.204 to ipaddr.js.
    for (const addr of ['2890342092', '0xac.71.30.204', '172.071.030.204', '', 'unknown', `${EDGE}:443`]) {
      expect(isCloudflareAddress(addr), addr).toBe(false);
    }
  });
});

describe('trustProxyFromEnv', () => {
  it('is null when unset, so callers keep trusting one hop', () => {
    expect(trustProxyFromEnv(undefined)).toBeNull();
    expect(trustProxyFromEnv('')).toBeNull();
  });

  it('refuses a value it does not know', () => {
    expect(() => trustProxyFromEnv('cloudfare')).toThrow(/TRUST_PROXY/);
    expect(() => trustProxyFromEnv('true')).toThrow(/TRUST_PROXY/);
    expect(() => trustProxyFromEnv('2')).toThrow(/TRUST_PROXY/);
  });
});

describe('forwardedClientAddress with TRUST_PROXY=cloudflare', () => {
  const trust = trustProxyFromEnv('cloudflare')!;
  const ip = (xff: string | undefined, socket = INGRESS) => forwardedClientAddress(socket, xff, trust);

  it('is the visitor behind a Cloudflare edge, IPv4 or IPv6', () => {
    expect(ip(`${VISITOR}, ${EDGE}`)).toBe(VISITOR);
    expect(ip(`${VISITOR}, 2a06:98c0:3600::1`)).toBe(VISITOR);
    expect(ip(`2001:db8::7, ${EDGE}`)).toBe('2001:db8::7');
  });

  it('is whoever connected to Cloudflare, whatever they put in front of it', () => {
    // A direct request to the *.ondigitalocean.app origin with forged
    // headers: Cloudflare appends the real address, the ingress the edge.
    expect(ip(`${FORGED}, ${ATTACKER}, ${EDGE}`)).toBe(ATTACKER);
    // A forged Cloudflare address in the chain doesn't extend the trust.
    expect(ip(`${FORGED}, ${EDGE}, ${ATTACKER}, ${EDGE}`)).toBe(ATTACKER);
  });

  it('stops at a second Cloudflare address: a Worker sends what it likes', () => {
    expect(ip(`${FORGED}, 2a06:98c0:3600::103, ${EDGE}`)).toBe('2a06:98c0:3600::103');
  });

  it("is the last hop when that isn't Cloudflare", () => {
    // Reached the ingress some other way: the ingress appends the caller.
    expect(ip(`${FORGED}, ${ATTACKER}`)).toBe(ATTACKER);
    expect(ip(`${FORGED}, ${EDGE}, ${ATTACKER}`)).toBe(ATTACKER);
    // Caddy (self-host) replaces X-Forwarded-For with the one address.
    expect(ip(VISITOR, '172.18.0.4')).toBe(VISITOR);
  });

  it('is the socket with no X-Forwarded-For at all', () => {
    expect(ip(undefined)).toBe(INGRESS);
    expect(ip(' , ')).toBe(INGRESS);
  });
});

describe('forwardedClientAddress with one trusted hop', () => {
  const oneHop = (_addr: string, hop: number) => hop < 1;

  it("matches Express's trust proxy 1", () => {
    expect(forwardedClientAddress(INGRESS, `${VISITOR}, ${EDGE}`, oneHop)).toBe(EDGE);
    expect(forwardedClientAddress(INGRESS, VISITOR, oneHop)).toBe(VISITOR);
    expect(forwardedClientAddress(INGRESS, undefined, oneHop)).toBe(INGRESS);
  });
});

describe("forwardedClientAddress is Express's req.ip", () => {
  // The router's walk against the real thing, odd headers included: Express
  // trims only spaces, so a tab stays part of the entry.
  const HEADERS = [
    undefined,
    `${VISITOR}, ${EDGE}`,
    `${VISITOR},${EDGE}`,
    `${FORGED}, ${ATTACKER}, ${EDGE}`,
    `${VISITOR},\t${EDGE}`,
    `${VISITOR}, \t , ${EDGE}`,
    `${VISITOR}, , ${EDGE},`,
    `  ${VISITOR}  ,  2a06:98c0:3600::1  `,
    `${FORGED} ${ATTACKER}, ${EDGE}`,
    'unknown, 2890342092',
  ];
  const trusts = { cloudflare: trustProxyFromEnv('cloudflare')!, oneHop: (_a: string, hop: number) => hop < 1 };

  for (const [name, trust] of Object.entries(trusts)) {
    it(`agrees for ${name}`, async () => {
      const app = express();
      app.set('trust proxy', trust);
      app.get('/ip', (req, res) => res.json({ ip: req.ip, socket: req.socket.remoteAddress }));
      for (const xff of HEADERS) {
        const call = request(app).get('/ip');
        const { body } = await (xff === undefined ? call : call.set('X-Forwarded-For', xff));
        expect(forwardedClientAddress(body.socket, xff, trust), JSON.stringify(xff)).toBe(body.ip);
      }
    });
  }
});
