/**
 * Email the platform admins when one of the creator index's mailboxes loses
 * its Microsoft connection (openpartner-network mailbox-oauth.ts): Microsoft
 * refused its refresh token, so the Network sends nothing from it until an
 * admin reconnects it in the ops console.
 *
 * Every admin (PlatformAdmin role 'admin', not revoked), once per loss: who
 * was told is remembered in PlatformSetting (mailbox → the loss and the
 * admins emailed about it), so an admin whose email failed is tried again
 * next run and nobody gets it twice. Same shape as
 * network-creator-review-alert.ts.
 *
 * Hosted multi-tenant only, like the rest of the ops console.
 */

import { DEFAULT_TENANT_ID, TABLES, type PlatformAdminRow, type PlatformSettingRow } from '@openpartner/db';
import { db } from './db.js';
import { getTenancyMode } from './tenancy.js';
import { getMailer } from './mailer.js';
import { adminGetMailboxes, NetworkAdminError, platformNetworkUrl, type NetworkMailboxKind } from './network-client.js';
import { opsMailboxLostEmail } from './email-templates.js';
import { getPortalBaseUrl } from './portal-url.js';

export interface MailboxAlertResult {
  skipped?: string;
  lost: NetworkMailboxKind[];
  alerted: NetworkMailboxKind[];
}

const ALERTED_KEY = 'network_mailbox_lost_alerted';

/** Per mailbox: the loss emailed about, and to whom. */
type Alerted = Partial<Record<NetworkMailboxKind, { lostAt: string; to: string[] }>>;

export async function alertAdminsToLostMailboxes(now = new Date()): Promise<MailboxAlertResult> {
  if (getTenancyMode() !== 'multi') return { skipped: 'single_tenant', lost: [], alerted: [] };
  const networkUrl = platformNetworkUrl();
  if (!networkUrl || !process.env.NETWORK_ADMIN_API_KEY) return { skipped: 'network_admin_not_configured', lost: [], alerted: [] };

  let mailboxes: Awaited<ReturnType<typeof adminGetMailboxes>>;
  try {
    mailboxes = await adminGetMailboxes(networkUrl);
  } catch (err) {
    // A Network deployed before mailbox connections has nothing to lose.
    if (err instanceof NetworkAdminError && err.status === 404) return { skipped: 'network_predates_mailboxes', lost: [], alerted: [] };
    throw err;
  }
  const lost = (['outreach', 'invite'] as const).filter((kind) => mailboxes[kind]?.connection?.status === 'lost');
  const row = await db<PlatformSettingRow>(TABLES.PlatformSetting).where({ key: ALERTED_KEY }).first();
  const alerted: Alerted = { ...((row?.value as Alerted | undefined) ?? {}) };
  if (lost.length === 0) return { lost, alerted: [] };
  const admins = (await db<PlatformAdminRow>(TABLES.PlatformAdmin).where({ role: 'admin' }).whereNull('revokedAt').select('email')).map((a) => a.email);
  if (admins.length === 0) return { skipped: 'no_admins', lost, alerted: [] };

  const sentFor: NetworkMailboxKind[] = [];
  for (const kind of lost) {
    const connection = mailboxes[kind]!.connection!;
    const told = alerted[kind]?.lostAt === connection.lostAt ? alerted[kind]!.to : [];
    const due = admins.filter((email) => !told.includes(email));
    if (due.length === 0) continue;
    const tmpl = opsMailboxLostEmail({
      mailbox: kind,
      account: connection.account,
      reason: connection.lostReason,
      consoleUrl: `${getPortalBaseUrl()}/platform/creator-index`,
    });
    const delivered: string[] = [];
    for (const email of due) {
      try {
        await getMailer().send(
          { db, tenantId: DEFAULT_TENANT_ID },
          { to: email, subject: tmpl.subject, text: tmpl.text, html: tmpl.html, tag: 'ops_mailbox_lost', metadata: { channel: 'platform_ops', mailbox: kind }, platform: true },
        );
        delivered.push(email);
      } catch (err) {
        console.error('[mailbox-alert] send failed', email, err);
      }
    }
    if (delivered.length > 0) {
      alerted[kind] = { lostAt: connection.lostAt!, to: [...told, ...delivered] };
      sentFor.push(kind);
    }
  }
  if (sentFor.length > 0) {
    await db(TABLES.PlatformSetting)
      .insert({ key: ALERTED_KEY, value: alerted as unknown as never, updatedByEmail: null, updatedAt: now })
      .onConflict('key')
      .merge({ value: alerted as unknown as never, updatedAt: now });
  }
  return { lost, alerted: sentFor };
}
