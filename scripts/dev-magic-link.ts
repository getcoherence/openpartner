/**
 * Dev helper: issue a fresh admin magic link and print it.
 *
 * Used to log into the portal locally without going through the
 * Postmark mailer. Picks the first activated-or-pending Admin row in
 * the default tenant.
 *
 * Usage from repo root:
 *   pnpm exec tsx scripts/dev-magic-link.ts
 */

import knex from 'knex';
import { ulid } from 'ulid';
import { createHash, randomBytes } from 'node:crypto';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://openpartner:openpartner@localhost:5433/openpartner';
const PORTAL_URL = process.env.PORTAL_URL ?? 'http://localhost:5673';
const DEFAULT_TENANT_ID = '01J0000000DEFAULTTENANT0000';

async function main() {
  const k = knex({ client: 'pg', connection: DATABASE_URL });
  try {
    const admin = await k('Admin').where({ tenantId: DEFAULT_TENANT_ID }).whereNull('revokedAt').first();
    if (!admin) {
      console.error('No admin row found. Run /install first.');
      process.exit(1);
    }
    const plaintext = `opml_${randomBytes(24).toString('hex')}`;
    const tokenHash = createHash('sha256').update(plaintext).digest('hex');
    const prefix = plaintext.slice(0, 8);
    await k('MagicLinkToken').insert({
      id: ulid(),
      tenantId: DEFAULT_TENANT_ID,
      prefix,
      tokenHash,
      email: admin.email,
      purpose: 'admin_invite',
      principalKind: 'admin',
      principalId: admin.id,
      expiresAt: new Date(Date.now() + 15 * 60 * 1000),
    });
    console.log(`${PORTAL_URL}/auth/magic?token=${plaintext}`);
  } finally {
    await k.destroy();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
