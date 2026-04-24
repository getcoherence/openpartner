/**
 * Transactional mailer. Transport is auto-selected from env:
 *
 *   SMTP_HOST + MAIL_FROM set               → nodemailer SMTP
 *   POSTMARK_SERVER_TOKEN + MAIL_FROM set   → Postmark HTTP API
 *   otherwise                               → console (stdout only)
 *
 * SMTP is the recommended path for self-hosted OSS — it works with any
 * provider (Gmail, Workspace, SES, Mailgun, SendGrid, Resend, Postmark,
 * a corporate relay, local Postfix). Postmark stays as a first-class
 * dedicated adapter because its API is slightly more robust for
 * transactional delivery. Console is for local dev only.
 *
 * Tests override via __setMailerForTests with an in-memory capturer.
 */

import nodemailer, { type Transporter } from 'nodemailer';

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

class ConsoleMailer implements Mailer {
  async send(msg: Message): Promise<void> {
    // Dev fallback when no transport creds are present. Prints enough
    // to recover the magic link from the terminal without needing a
    // real mailbox.
    console.log(`[mail] to=${msg.to} subject=${JSON.stringify(msg.subject)}`);
    console.log(msg.text);
  }
}

class SMTPMailer implements Mailer {
  constructor(
    private readonly transporter: Transporter,
    private readonly from: string,
  ) {}

  async send(msg: Message): Promise<void> {
    await this.transporter.sendMail({
      from: this.from,
      to: msg.to,
      subject: msg.subject,
      text: msg.text,
      html: msg.html,
      headers: msg.tag ? { 'X-Tag': msg.tag } : undefined,
    });
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
  const from = process.env.MAIL_FROM;
  const smtpHost = process.env.SMTP_HOST;
  const postmarkToken = process.env.POSTMARK_SERVER_TOKEN;

  if (smtpHost && from) {
    const transporter = nodemailer.createTransport({
      host: smtpHost,
      port: Number(process.env.SMTP_PORT ?? 587),
      // Defaults to STARTTLS on 587; set SMTP_SECURE=1 for implicit TLS
      // on 465. Leave off for providers that auto-detect.
      secure: process.env.SMTP_SECURE === '1' || process.env.SMTP_PORT === '465',
      auth:
        process.env.SMTP_USER && process.env.SMTP_PASSWORD
          ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD }
          : undefined,
    });
    cached = new SMTPMailer(transporter, from);
    return cached;
  }
  if (postmarkToken && from) {
    cached = new PostmarkMailer(postmarkToken, from, process.env.POSTMARK_MESSAGE_STREAM ?? 'outbound');
    return cached;
  }
  cached = new ConsoleMailer();
  return cached;
}

/** For tests: inject a capturing / mock mailer. Pass null to reset. */
export function __setMailerForTests(mailer: Mailer | null): void {
  cached = mailer;
}
