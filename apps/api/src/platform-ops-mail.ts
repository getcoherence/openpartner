/**
 * Platform-ops email channel — internal alerts to the operator inbox
 * (PLATFORM_OPS_EMAIL). Shared by brand review and billing lifecycle
 * notifications.
 *
 * Sends through the PLATFORM mail transport: DEFAULT_TENANT_ID as the mail
 * context makes resolveMailConfig fall through to the env transport rather
 * than a brand's UI-configured provider — an internal ops alert must never
 * egress via a customer's Postmark account.
 */

import type { Knex } from 'knex';
import { DEFAULT_TENANT_ID } from '@openpartner/db';
import { getMailer } from './mailer.js';
import type { EmailTemplate } from './email-templates.js';

/** The platform-ops inbox that internal notifications go to. Unset → ops
 *  email is skipped (self-host / dev). */
export function platformOpsEmail(): string | null {
  const v = (process.env.PLATFORM_OPS_EMAIL ?? '').trim();
  return v.length > 0 ? v : null;
}

/** Best-effort send to the ops inbox — never throws; an alert failure must
 *  not fail the webhook / job that triggered it. */
export async function sendOpsEmail(db: Knex, tmpl: EmailTemplate, tag: string): Promise<void> {
  const to = platformOpsEmail();
  if (!to) return;
  try {
    await getMailer().send(
      { db, tenantId: DEFAULT_TENANT_ID },
      {
        to,
        subject: tmpl.subject,
        text: tmpl.text,
        html: tmpl.html,
        tag,
        metadata: { channel: 'platform_ops' },
      },
    );
  } catch (err) {
    console.error('[platform-ops-mail] ops notify failed', err);
  }
}
