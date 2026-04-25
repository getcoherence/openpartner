/**
 * Transactional mailer. Transport comes from resolveMailConfig():
 *
 *   UI-configured settings (Config table) take precedence — stored
 *   encrypted at rest; SMTP password / Postmark token decrypted at
 *   dispatch time.
 *
 *   Env fallback if UI is empty (SMTP_HOST / POSTMARK_SERVER_TOKEN +
 *   MAIL_FROM).
 *
 *   Console fallback if neither — dev only; the magic link prints
 *   to the `pnpm dev:api` terminal.
 *
 * Mailers are created per-send so a settings change takes effect on
 * the next email without a restart. A cached mailer would be a stale-
 * creds footgun after rotation.
 *
 * Tests override via __setMailerForTests with an in-memory capturer.
 */

import nodemailer from 'nodemailer';
import { resolveMailConfig } from './mail-settings.js';

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

class RoutingMailer implements Mailer {
  async send(msg: Message): Promise<void> {
    const cfg = await resolveMailConfig();
    if (cfg.kind === 'smtp' && cfg.smtp && cfg.from) {
      const transporter = nodemailer.createTransport({
        host: cfg.smtp.host,
        port: cfg.smtp.port,
        secure: cfg.smtp.secure,
        auth:
          cfg.smtp.user && cfg.smtp.password
            ? { user: cfg.smtp.user, pass: cfg.smtp.password }
            : undefined,
      });
      await transporter.sendMail({
        from: cfg.from,
        to: msg.to,
        subject: msg.subject,
        text: msg.text,
        html: msg.html,
        headers: msg.tag ? { 'X-Tag': msg.tag } : undefined,
      });
      return;
    }
    if (cfg.kind === 'postmark' && cfg.postmark && cfg.from) {
      const res = await fetch('https://api.postmarkapp.com/email', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          'X-Postmark-Server-Token': cfg.postmark.serverToken,
        },
        body: JSON.stringify({
          From: cfg.from,
          To: msg.to,
          Subject: msg.subject,
          TextBody: msg.text,
          HtmlBody: msg.html,
          Tag: msg.tag,
          MessageStream: cfg.postmark.messageStream,
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
      return;
    }
    // Console fallback. Dev only.
    console.log(`[mail] to=${msg.to} subject=${JSON.stringify(msg.subject)}`);
    console.log(msg.text);
  }
}

let override: Mailer | null = null;
const routing = new RoutingMailer();

export function getMailer(): Mailer {
  return override ?? routing;
}

/** For tests: inject a capturing / mock mailer. Pass null to reset. */
export function __setMailerForTests(mailer: Mailer | null): void {
  override = mailer;
}
