/**
 * Transactional mailer for partner invite + signin magic links.
 *
 * Transport is implicit from env:
 *   POSTMARK_SERVER_TOKEN + MAIL_FROM set → Postmark
 *   otherwise                            → console (stdout only)
 *
 * Tests override via __setMailerForTests with an in-memory capturer.
 */

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
    // Dev fallback when no Postmark creds are present. Prints enough to
    // recover the magic link from the terminal without needing a mailbox
    // UI or third-party sandbox.
    console.log(`[mail] to=${msg.to} subject=${JSON.stringify(msg.subject)}`);
    console.log(msg.text);
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
  const token = process.env.POSTMARK_SERVER_TOKEN;
  const from = process.env.MAIL_FROM;
  if (token && from) {
    cached = new PostmarkMailer(token, from, process.env.POSTMARK_MESSAGE_STREAM ?? 'outbound');
  } else {
    cached = new ConsoleMailer();
  }
  return cached;
}

/** For tests: inject a capturing / mock mailer. Pass null to reset. */
export function __setMailerForTests(mailer: Mailer | null): void {
  cached = mailer;
}
