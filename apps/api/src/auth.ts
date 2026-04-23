/**
 * Bearer-token auth.
 *
 * Two shapes of credential:
 *   - ADMIN_API_KEY env var — bootstrap admin key, valid in all modes.
 *   - ApiKey rows in the database — either admin (partnerId null) or partner-scoped.
 *
 * We never store plaintext. Keys look like `op_<24 hex>` and are identified by
 * an 8-char prefix so lookups are indexed rather than table scans. The hash is
 * sha256 over the whole key.
 */

import { createHash, randomBytes } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { ulid } from 'ulid';
import { TABLES, type ApiKeyRow } from '@openpartner/db';
import { db } from './db.js';

export type ApiKeyPrincipal =
  | { role: 'admin'; source: 'env' }
  | { role: 'admin'; source: 'db'; apiKeyId: string }
  | { role: 'partner'; source: 'db'; apiKeyId: string; partnerId: string }
  | { role: 'network_vendor'; source: 'db'; apiKeyId: string; networkVendorId: string }
  | { role: 'network_creator'; source: 'db'; apiKeyId: string; networkCreatorId: string };

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      principal?: ApiKeyPrincipal;
    }
  }
}

export const KEY_PREFIX_LEN = 8;

export function generateApiKey(): { plaintext: string; prefix: string; hash: string } {
  const plaintext = `op_${randomBytes(24).toString('hex')}`;
  return {
    plaintext,
    prefix: plaintext.slice(0, KEY_PREFIX_LEN),
    hash: hashKey(plaintext),
  };
}

export function hashKey(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex');
}

export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const principal = await resolvePrincipal(req);
  if (!principal) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  req.principal = principal;
  next();
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (req.principal?.role !== 'admin') {
    res.status(403).json({ error: 'forbidden' });
    return;
  }
  next();
}

export function requirePartnerOrAdmin(paramName: string = 'id') {
  return (req: Request, res: Response, next: NextFunction): void => {
    const p = req.principal;
    if (!p) return void res.status(401).json({ error: 'unauthorized' });
    if (p.role === 'admin') return next();
    if (p.role === 'partner' && p.partnerId === req.params[paramName]) return next();
    res.status(403).json({ error: 'forbidden' });
  };
}

async function resolvePrincipal(req: Request): Promise<ApiKeyPrincipal | null> {
  const header = req.header('authorization');
  if (!header) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  if (!match) return null;
  const token = match[1]!;

  const envAdmin = process.env.ADMIN_API_KEY;
  if (envAdmin && constantTimeEqual(token, envAdmin)) {
    return { role: 'admin', source: 'env' };
  }

  if (token.length < KEY_PREFIX_LEN) return null;

  const prefix = token.slice(0, KEY_PREFIX_LEN);
  const hash = hashKey(token);

  const candidates = await db<ApiKeyRow>(TABLES.ApiKey).where({ prefix }).whereNull('revokedAt');
  const match2 = candidates.find((row) => constantTimeEqual(row.keyHash, hash));
  if (!match2) return null;

  // Non-blocking last-used bump.
  void db<ApiKeyRow>(TABLES.ApiKey).where({ id: match2.id }).update({ lastUsedAt: new Date() });

  if (match2.networkVendorId) {
    return { role: 'network_vendor', source: 'db', apiKeyId: match2.id, networkVendorId: match2.networkVendorId };
  }
  if (match2.networkCreatorId) {
    return { role: 'network_creator', source: 'db', apiKeyId: match2.id, networkCreatorId: match2.networkCreatorId };
  }
  if (match2.partnerId) {
    return { role: 'partner', source: 'db', apiKeyId: match2.id, partnerId: match2.partnerId };
  }
  return { role: 'admin', source: 'db', apiKeyId: match2.id };
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function createApiKeyRow(params: {
  partnerId?: string | null;
  networkVendorId?: string | null;
  networkCreatorId?: string | null;
  label?: string;
}): Promise<{ id: string; plaintext: string }> {
  const { plaintext, prefix, hash } = generateApiKey();
  const id = ulid();
  await db<ApiKeyRow>(TABLES.ApiKey).insert({
    id,
    prefix,
    keyHash: hash,
    partnerId: params.partnerId ?? null,
    networkVendorId: params.networkVendorId ?? null,
    networkCreatorId: params.networkCreatorId ?? null,
    label: params.label ?? null,
  });
  return { id, plaintext };
}

export function requireNetworkVendor(req: Request, res: Response, next: NextFunction): void {
  const p = req.principal;
  if (!p) return void res.status(401).json({ error: 'unauthorized' });
  if (p.role === 'admin' || p.role === 'network_vendor') return next();
  res.status(403).json({ error: 'forbidden' });
}

export function requireNetworkCreator(req: Request, res: Response, next: NextFunction): void {
  const p = req.principal;
  if (!p) return void res.status(401).json({ error: 'unauthorized' });
  if (p.role === 'admin' || p.role === 'network_creator') return next();
  res.status(403).json({ error: 'forbidden' });
}
