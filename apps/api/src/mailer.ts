/**
 * Mail delivery. We deliberately keep the abstraction tiny — a single
 * send() that takes { to, subject, text, html?, metadata? }.
 *
 * Two implementations:
 *   DevMailer  persists to the DevMessage table. An admin-only
 *              /dev/mailbox endpoint reads them back so local dev and
 *              CI can follow magic links without configuring SMTP.
 *   SmtpMailer shell for the production path. Wire nodemailer in once
 *              we pick a provider. Intentionally not implemented yet
 *              so we don't leak credentials into the repo.
 *
 * The factory returns DevMailer unless MAIL_TRANSPORT=smtp. Selfhost
 * deployments can opt into SMTP per-instance by setting that env.
 */

import { ulid } from 'ulid';
import { TABLES, type DevMessageRow } from '@openpartner/db';
import { db } from './db.js';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
  metadata?: Record<string, unknown>;
}

export interface Mailer {
  send(msg: MailMessage): Promise<void>;
}

class DevMailer implements Mailer {
  async send(msg: MailMessage): Promise<void> {
    await db<DevMessageRow>(TABLES.DevMessage).insert({
      id: ulid(),
      to: msg.to,
      subject: msg.subject,
      body: msg.text,
      html: msg.html ?? null,
      metadata: (msg.metadata ?? {}) as never,
    });
    console.log(`[dev-mail] to=${msg.to} subject="${msg.subject}"`);
  }
}

class SmtpMailer implements Mailer {
  async send(_msg: MailMessage): Promise<void> {
    // Plumbing intentionally deferred — pick a provider (Resend /
    // Postmark / SES), add the SDK, fill this in. Refusing to silently
    // no-op in prod forces the deployer to pick.
    throw new Error('SMTP mailer not yet implemented. Set MAIL_TRANSPORT=dev or implement SmtpMailer.');
  }
}

let mailerInstance: Mailer | null = null;

export function getMailer(): Mailer {
  if (mailerInstance) return mailerInstance;
  const transport = process.env.MAIL_TRANSPORT ?? 'dev';
  mailerInstance = transport === 'smtp' ? new SmtpMailer() : new DevMailer();
  return mailerInstance;
}
