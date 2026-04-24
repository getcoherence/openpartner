/**
 * Transactional mailer for partner invite + signin magic links.
 *
 * Two transports:
 *   dev       writes to the DevMessage table so tests + local devs can
 *             read the link back without Postmark credentials.
 *   postmark  POSTs to api.postmarkapp.com/email.
 *
 * Minimal and partner-scoped — the earlier multi-purpose mailer (creator
 * signups, vendor approvals, cross-network notifications) was carved out
 * with the Network service.
 */

import { ulid } from 'ulid';
import { TABLES, type DevMessageRow } from '@openpartner/db';
import { db } from './db.js';

export interface Message {
  to: string;
  subject: string;
  text: string;
  html?: string;
  tag?: string;
  metadata?: Record<string, unknown>;
}

export interface Mailer {
  send(msg: Message): Promise<void>;
}

class DevMailer implements Mailer {
  async send(msg: Message): Promise<void> {
    await db<DevMessageRow>(TABLES.DevMessage).insert({
      id: ulid(),
      to: msg.to,
      subject: msg.subject,
      body: msg.text,
      html: msg.html ?? null,
      metadata: (msg.metadata ?? {}) as unknown as never,
    });
    // Also print so `pnpm dev:api` shows the link without opening the portal.
    console.log(`[dev-mail] to=${msg.to} subject=${JSON.stringify(msg.subject)}`);
  }
}

class PostmarkMailer implements Mailer {
  constructor(
    private readonly serverToken: string,
    private readonly from: string,
    private readonly messageStream: string,
  ) {}

  async send(msg: Message): Promise<void> {
    const res = await fetch('https://api.postmarkapp.com/email', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'X-Postmark-Server-Token': this.serverToken,
      },
      body: JSON.stringify({
        From: this.from,
        To: msg.to,
        Subject: msg.subject,
        TextBody: msg.text,
        HtmlBody: msg.html,
        Tag: msg.tag,
        MessageStream: this.messageStream,
        Metadata: msg.metadata,
      }),
    });
    if (!res.ok) {
      throw new Error(`postmark ${res.status}: ${await res.text().catch(() => '<no body>')}`);
    }
    const json = (await res.json().catch(() => ({}))) as { ErrorCode?: number; Message?: string };
    if (json.ErrorCode && json.ErrorCode !== 0) {
      throw new Error(`postmark error ${json.ErrorCode}: ${json.Message ?? 'unknown'}`);
    }
  }
}

let cached: Mailer | null = null;

export function getMailer(): Mailer {
  if (cached) return cached;
  const transport = process.env.MAIL_TRANSPORT ?? 'dev';
  if (transport === 'postmark') {
    const token = process.env.POSTMARK_SERVER_TOKEN;
    const from = process.env.MAIL_FROM;
    if (!token || !from) {
      throw new Error('MAIL_TRANSPORT=postmark requires POSTMARK_SERVER_TOKEN and MAIL_FROM');
    }
    cached = new PostmarkMailer(token, from, process.env.POSTMARK_MESSAGE_STREAM ?? 'outbound');
    return cached;
  }
  cached = new DevMailer();
  return cached;
}

/** For tests: swap in a mock mailer. */
export function __setMailerForTests(mailer: Mailer | null): void {
  cached = mailer;
}
