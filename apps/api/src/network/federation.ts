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

export interface FederationCreator {
  name: string;
  email: string;
  handle: string;
  promoCode?: string | null;
}

export interface PartnerDashboardStats {
  partnerId: string;
  since: string;
  clicks: number;
  attributedEvents: number;
  attributedRevenue: number;
  commissionByStatus: Record<string, number>;
}

/**
 * Read-side federation: pull a partner's dashboard off their vendor's
 * OpenPartner instance. Used by the Network to surface per-partnership
 * earnings to creators (and to vendors, inverted — "how much has this
 * creator earned you?"). Attribution never leaves the vendor's instance;
 * we just project it into the Network UI.
 */
export async function fetchPartnerDashboard(
  vendor: NetworkVendorRow,
  partnerId: string,
): Promise<PartnerDashboardStats> {
  const key = decryptKey(vendor.instanceKeyCiphertext);
  const res = await fetchJson(`${vendor.instanceUrl}/partners/${partnerId}/dashboard`, {
    method: 'GET',
    key,
  });
  return res as unknown as PartnerDashboardStats;
}

export interface FederatedPartner {
  partnerId: string;
  linkKey: string;
  publicShareUrl: string;
  routerUrl: string;
}

export async function provisionPartnerOnVendor(params: {
  vendor: NetworkVendorRow;
  offering: OfferingRow;
  creator: FederationCreator;
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

  // Preferred link key order: request-level promoCode → creator handle. The
  // slug is what appears in the share URL (e.g. getcoherence.io/r/<slug>),
  // so we respect whatever the creator chose up-front. If uniqueness
  // collides on the vendor's instance, fetchJsonWithFallback retries with
  // a short suffix so the creator still gets something close to what they
  // picked instead of the provisioning failing outright.
  const linkKey = sanitizeLinkKey(creator.promoCode || creator.handle);
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
  const routerUrl = deriveRouterUrl(vendor);
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

function deriveRouterUrl(vendor: NetworkVendorRow): string {
  // Priority: explicit NetworkVendor.routerUrl → env override → port-swap
  // convention (API 4601 → router 4701) for localhost dev. Production
  // vendors should set routerUrl to their branded apex (e.g.
  // https://getcoherence.io) so share URLs land at the right hostname.
  if (vendor.routerUrl) return vendor.routerUrl;
  const env = process.env.NETWORK_ROUTER_URL;
  if (env) return env;
  try {
    const url = new URL(vendor.instanceUrl);
    if (url.port === '4601') {
      url.port = '4701';
      return url.origin;
    }
  } catch {
    /* ignore */
  }
  return vendor.instanceUrl;
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
