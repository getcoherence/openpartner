/**
 * Mail delivery. The abstraction stays tiny — a single send() that takes
 * { to, subject, text, html?, metadata? }.
 *
 * Two implementations:
 *   DevMailer       persists to the DevMessage table. An admin-only
 *                   /dev/mailbox endpoint reads them back so local dev
 *                   and CI can follow magic links without configuring
 *                   a real provider.
 *   PostmarkMailer  POSTs to Postmark's Email API over native fetch
 *                   (no SDK dep). Used in any environment with
 *                   MAIL_TRANSPORT=postmark set.
 *
 * The factory reads MAIL_TRANSPORT:
 *   "postmark"  → PostmarkMailer (requires POSTMARK_SERVER_TOKEN + MAIL_FROM)
 *   anything else → DevMailer
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
  /**
   * Opaque tag Postmark stores alongside the message. We use it to
   * distinguish creator_signup / creator_signin / vendor_signup /
   * vendor_signin in dashboards and searches.
   */
  tag?: string;
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

class PostmarkMailer implements Mailer {
  constructor(
    private readonly serverToken: string,
    private readonly from: string,
    private readonly messageStream: string,
  ) {}

  async send(msg: MailMessage): Promise<void> {
    const res = await fetch('https://api.postmarkapp.com/email', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'x-postmark-server-token': this.serverToken,
      },
      body: JSON.stringify({
        From: this.from,
        To: msg.to,
        Subject: msg.subject,
        TextBody: msg.text,
        HtmlBody: msg.html,
        MessageStream: this.messageStream,
        Tag: msg.tag,
        // Metadata values must be strings per Postmark's contract.
        Metadata: msg.metadata
          ? Object.fromEntries(Object.entries(msg.metadata).map(([k, v]) => [k, String(v)]))
          : undefined,
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`postmark send failed: ${res.status} ${text.slice(0, 300)}`);
    }

    // 200 with ErrorCode=0 is the success shape; ErrorCode != 0 is a
    // per-message rejection (recipient suppressed, blocked, etc). Both
    // are worth knowing about, but only ErrorCode != 0 with a non-zero
    // status should throw. Postmark returns ErrorCode=0 on 200.
    const body = (await res.json()) as { ErrorCode?: number; Message?: string };
    if (body.ErrorCode && body.ErrorCode !== 0) {
      throw new Error(`postmark rejected message: ${body.ErrorCode} ${body.Message ?? ''}`);
    }
  }
}

let mailerInstance: Mailer | null = null;

export function getMailer(): Mailer {
  if (mailerInstance) return mailerInstance;
  const transport = process.env.MAIL_TRANSPORT ?? 'dev';
  if (transport === 'postmark') {
    const token = process.env.POSTMARK_SERVER_TOKEN;
    const from = process.env.MAIL_FROM;
    if (!token) throw new Error('MAIL_TRANSPORT=postmark requires POSTMARK_SERVER_TOKEN');
    if (!from) throw new Error('MAIL_TRANSPORT=postmark requires MAIL_FROM');
    const stream = process.env.POSTMARK_MESSAGE_STREAM ?? 'outbound';
    mailerInstance = new PostmarkMailer(token, from, stream);
  } else {
    mailerInstance = new DevMailer();
  }
  return mailerInstance;
}

/**
 * Reset for tests that want to change env vars between runs. Not used
 * in production code paths.
 */
export function __resetMailerForTests(): void {
  mailerInstance = null;
}
