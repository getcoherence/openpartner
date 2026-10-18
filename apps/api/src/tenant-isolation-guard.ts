/**
 * Boot-time check that the app pool is actually subject to RLS.
 *
 * In multi-tenant mode Postgres row-level security is the boundary between
 * tenants. The app-level `tenantId` filters are defence in depth, and they
 * are NOT complete: an Oct 2026 verification ran multi-tenant with
 * DATABASE_URL_APP unset, so `appDb` connected as the migration role and RLS
 * never applied. One tenant's scoped key then read another tenant's partners
 * through GET /partners, the CSV import granted every tenant's programs, and
 * usage billing summed every tenant's GMV.
 *
 * So a multi-tenant API refuses to start unless the app connection:
 *   1. is not a superuser and has no BYPASSRLS (both skip every policy), and
 *   2. has RLS active on every table that enables it. This catches the case
 *      (1) misses: a role that OWNS the tables, such as a managed cluster's
 *      admin user. Owners skip the policies of any table without FORCE RLS
 *      (Coupon, as of Oct 2026).
 *
 * Single-tenant self-host has one tenant, so nothing to isolate, and keeps
 * running as the migration role.
 */
import type { Knex } from 'knex';
import { appDb } from './db.js';
import { getTenancyMode, type TenancyMode } from './tenancy.js';

const DOCS = 'docs/deploy-production.md#tenant-isolation-the-app-role';

export interface AppRoleStatus {
  role: string;
  superuser: boolean;
  bypassRls: boolean;
  /** RLS-enabled tables whose policies do NOT apply to this connection. */
  tablesWithoutRls: string[];
}

export async function inspectAppRole(conn: Knex): Promise<AppRoleStatus> {
  const role = (await conn.raw(
    `select current_user as role, r.rolsuper as superuser, r.rolbypassrls as bypass_rls
       from pg_roles r where r.rolname = current_user`,
  )) as { rows: Array<{ role: string; superuser: boolean; bypass_rls: boolean }> };
  const r = role.rows[0];
  if (!r) throw new Error('[tenant-isolation] could not read the app connection role from pg_roles');
  // row_security_active() is Postgres's own verdict for this user: it
  // accounts for superuser, BYPASSRLS, ownership and FORCE RLS.
  const tables = (await conn.raw(
    `select c.relname
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = current_schema()
        and c.relkind in ('r', 'p')
        and c.relrowsecurity
        and not row_security_active(c.oid)
      order by c.relname`,
  )) as { rows: Array<{ relname: string }> };
  return {
    role: r.role,
    superuser: r.superuser,
    bypassRls: r.bypass_rls,
    tablesWithoutRls: tables.rows.map((t) => t.relname),
  };
}

/** Why `status` can't isolate tenants, or null when it can. */
export function rlsProblem(status: AppRoleStatus): string | null {
  if (status.superuser) return `role "${status.role}" is a superuser`;
  if (status.bypassRls) return `role "${status.role}" has BYPASSRLS`;
  if (status.tablesWithoutRls.length > 0) {
    const shown = status.tablesWithoutRls.slice(0, 5).join(', ');
    const more = status.tablesWithoutRls.length > 5 ? ` and ${status.tablesWithoutRls.length - 5} more` : '';
    return (
      `role "${status.role}" is not subject to RLS on ${shown}${more}, ` +
      `most likely because it owns those tables`
    );
  }
  return null;
}

/**
 * Throw if this is a multi-tenant deployment whose app pool bypasses RLS.
 * server.ts calls it before listening. A failed check stops the boot, so a
 * misconfigured deploy fails its health check instead of serving traffic.
 */
export async function assertAppPoolEnforcesRls(
  conn: Knex = appDb,
  mode: TenancyMode = getTenancyMode(),
): Promise<void> {
  if (mode !== 'multi') return;
  const problem = rlsProblem(await inspectAppRole(conn));
  if (!problem) return;
  throw new Error(
    `[tenant-isolation] Refusing to start: OPENPARTNER_TENANCY=multi, but the app database ` +
      `connection bypasses row-level security (${problem}). Tenants could read and write each ` +
      `other's data. Point DATABASE_URL_APP at the non-privileged openpartner_app role, ` +
      `provisioned by the migrations when OPENPARTNER_APP_DB_PASSWORD is set. ` +
      `${process.env.DATABASE_URL_APP ? '' : 'DATABASE_URL_APP is unset, so the app pool fell back to DATABASE_URL. '}` +
      `See ${DOCS}.`,
  );
}
