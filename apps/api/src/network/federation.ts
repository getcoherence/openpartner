/**
 * Federation client.
 *
 * When the Network approves a Partnership, we provision the actual
 * Partner + Link on the vendor's OpenPartner instance — that's where
 * attribution and payouts live. We call the vendor's admin API using the
 * encrypted key the vendor supplied at registration.
 *
 * The client is resilient: if the vendor's instance is unreachable, the
 * approval is rolled back so the creator isn't left with a half-provisioned
 * partnership. (See network-requests.ts for the transaction boundary.)
 */

import type { NetworkVendorRow, OfferingRow } from '@openpartner/db';
import { decryptKey } from './crypto.js';

export interface FederatedPartner {
  partnerId: string;
  linkKey: string;
  publicShareUrl: string;
  routerUrl: string;
}

export async function provisionPartnerOnVendor(params: {
  vendor: NetworkVendorRow;
  offering: OfferingRow;
  creator: { name: string; email: string; handle: string };
}): Promise<FederatedPartner> {
  const { vendor, offering, creator } = params;
  const key = decryptKey(vendor.instanceKeyCiphertext);

  const createPartnerRes = await fetchJson(`${vendor.instanceUrl}/partners`, {
    method: 'POST',
    key,
    body: {
      email: creator.email,
      name: creator.name,
      metadata: { source: 'openpartner_network', creatorHandle: creator.handle },
    },
  });

  const partnerId = String(createPartnerRes.id);

  // The link key embeds the creator's handle so the share URL is readable.
  // Uniqueness is enforced per-vendor-instance; if it collides, append the
  // partnerId suffix as a fallback.
  const linkKey = sanitizeLinkKey(creator.handle);
  const linkPayload = {
    linkKey,
    campaignId: offering.vendorCampaignId,
    destinationUrl: offering.productUrl,
  };

  const linkRes = await fetchJsonWithFallback(`${vendor.instanceUrl}/partners/${partnerId}/links`, {
    method: 'POST',
    key,
    body: linkPayload,
    fallbackBody: { ...linkPayload, linkKey: `${linkKey}-${partnerId.slice(-6).toLowerCase()}` },
  });

  // Router URL is co-deployed with the vendor's OpenPartner. Convention:
  // swap the API host's default port (4601) for the router's (4701), or
  // honor a routerUrl override we could add to NetworkVendor later.
  const routerUrl = deriveRouterUrl(vendor.instanceUrl);
  const actualLinkKey = String(linkRes.linkKey);
  const publicShareUrl = `${routerUrl}/r/${actualLinkKey}`;

  return { partnerId, linkKey: actualLinkKey, publicShareUrl, routerUrl };
}

function sanitizeLinkKey(raw: string): string {
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  return cleaned || 'creator';
}

function deriveRouterUrl(instanceUrl: string): string {
  // Our default dev setup: API on :4601, router on :4701. In prod, most
  // vendors will want the router on a branded apex (go.vendor.com), so this
  // should become a field on NetworkVendor. For now, honor the convention.
  const env = process.env.NETWORK_ROUTER_URL;
  if (env) return env;
  try {
    const url = new URL(instanceUrl);
    if (url.port === '4601') {
      url.port = '4701';
      return url.origin;
    }
  } catch {
    /* ignore */
  }
  return instanceUrl;
}

interface FetchParams {
  method: 'POST' | 'GET';
  key: string;
  body?: unknown;
}

async function fetchJson(url: string, params: FetchParams): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    method: params.method,
    headers: {
      authorization: `Bearer ${params.key}`,
      'content-type': 'application/json',
    },
    body: params.body !== undefined ? JSON.stringify(params.body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${params.method} ${url} → ${res.status}: ${text.slice(0, 300)}`);
  }
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

async function fetchJsonWithFallback(
  url: string,
  params: FetchParams & { fallbackBody: unknown },
): Promise<Record<string, unknown>> {
  try {
    return await fetchJson(url, { method: params.method, key: params.key, body: params.body });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('409') || msg.includes('linkKey_taken')) {
      return fetchJson(url, { method: params.method, key: params.key, body: params.fallbackBody });
    }
    throw err;
  }
}
