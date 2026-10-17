/**
 * Resolve the user-facing brand name for a tenant.
 *
 * Priority:
 *   1. program_settings.programName from Config (admin-set in Settings)
 *   2. Tenant.displayName (set at signup; always populated for hosted)
 *   3. null (callers fall back to a generic phrase)
 */

import type { Knex } from 'knex';
import { TABLES, type ConfigRow, type TenantRow } from '@openpartner/db';

export async function resolveBrandName(db: Knex, tenantId: string): Promise<string | null> {
  const row = await db<ConfigRow>(TABLES.Config).where({ tenantId, key: 'program_settings' }).first();
  const value = (row?.value ?? {}) as { programName?: string };
  if (value.programName && value.programName.trim()) return value.programName.trim();
  const tenant = await db<TenantRow>(TABLES.Tenant).where({ id: tenantId }).first();
  return tenant?.displayName ?? null;
}
