/**
 * Transactional mailer. Transport comes from resolveMailConfig():
 *
 *   UI-configured settings (Config table, per-tenant) take precedence —
 *   stored encrypted at rest; SMTP password / Postmark token decrypted at
 *   dispatch time.
 *
 *   Env fallback if UI is empty (SMTP_HOST / POSTMARK_SERVER_TOKEN +
 *   MAIL_FROM). Env is shared platform-wide.
 *
 *   Console fallback if neither — dev only; the magic link prints
 *   to the `pnpm dev:api` terminal.
 *
 * Mailers are created per-send so a settings change takes effect on
 * the next email without a restart. A cached mailer would be a stale-
 * creds footgun after rotation.
 *
 * Multi-tenant: every send takes a `{ db, tenantId }` context so we look
 * up the right tenant's UI overrides. Pass through the request's `req.db`
 * (transaction with app.tenant_id pinned).
 *
 * Tests override via __setMailerForTests with an in-memory capturer.
 */

import type { Knex } from 'knex';
import nodemailer from 'nodemailer';
import { resolveMailConfig } from './mail-settings.js';
import { resolveBrandName } from './brand-name.js';
import { getWhiteLabelState } from './white-label.js';
import { TABLES, type ConfigRow } from '@openpartner/db';

export interface Message {
  to: string;
  subject: string;
  text: string;
  html?: string;
  tag?: string;
  metadata?: Record<string, unknown>;
}

export interface SendContext {
  db: Knex;
  tenantId: string;
}

export interface Mailer {
  send(ctx: SendContext, msg: Message): Promise<void>;
}

/** Strip and quote pieces of a name for safe use in an RFC 5322 display
 *  name. Drops control chars and double-quotes; trims to 80 chars.
 *  The control-char range is intentional — it's exactly what RFC 5322
 *  forbids in atom + quoted-string productions. */
// eslint-disable-next-line no-control-regex
const DISPLAY_NAME_UNSAFE = /[\x00-\x1f"\\]/g;
function safeDisplayName(name: string): string {
  return name.replace(DISPLAY_NAME_UNSAFE, '').trim().slice(0, 80);
}

/** Pull the bare email address out of `"Name" <addr@host>` or `addr@host`. */
function extractAddress(from: string): string {
  const m = from.match(/<([^>]+)>/);
  return (m?.[1] ?? from).trim();
}

class RoutingMailer implements Mailer {
  async send(ctx: SendContext, msg: Message): Promise<void> {
    const cfg = await resolveMailConfig(ctx.db, ctx.tenantId);

    // Brand-aware From + Reply-To when we're using the platform fallback
    // (source='env'). Pattern: `"Acme via OpenPartner" <noreply@openpartner.dev>`,
    // Reply-To = the brand's support email if set. Means hosted brands
    // get brand identity in the inbox without configuring email at all.
    // For source='ui' (brand wired up their own provider) we trust their
    // From and don't second-guess it.
    let from = cfg.from ?? null;
    let replyTo: string | undefined;
    if (cfg.source === 'env' && from) {
      const brandName = await resolveBrandName(ctx.db, ctx.tenantId);
      if (brandName) {
        // White-label tenants get a clean brand-only From — no "via
        // OpenPartner" platform attribution. (Auth is unaffected: the
        // platform-fallback sender is still on openpartner.dev, which
        // SPF/DKIM authenticate; only the display name changes. A tenant
        // wanting the address itself white-labeled configures their own
        // provider — source='ui' — which skips this block entirely.)
        const wl = await getWhiteLabelState(ctx.db, ctx.tenantId);
        from = wl.effective
          ? `"${safeDisplayName(brandName)}" <${extractAddress(from)}>`
          : `"${safeDisplayName(brandName)} via OpenPartner" <${extractAddress(from)}>`;
      }
      const supportRow = await ctx.db<ConfigRow>(TABLES.Config)
        .where({ tenantId: ctx.tenantId, key: 'program_settings' })
        .first();
      const supportEmail = ((supportRow?.value as { supportEmail?: string } | undefined)?.supportEmail ?? '').trim();
      if (supportEmail) {
        replyTo = supportEmail;
      } else {
        // Fallback: oldest active admin on the tenant. Means a partner
        // hitting Reply on a sign-in email always lands on a human at
        // the brand, even before Settings → Brand info is filled in.
        const fallbackAdmin = await ctx.db(TABLES.Admin)
          .where({ tenantId: ctx.tenantId })
          .whereNotNull('activatedAt')
          .whereNull('revokedAt')
          .orderBy('activatedAt', 'asc')
          .first(['email']);
        if (fallbackAdmin?.email) replyTo = fallbackAdmin.email as string;
      }
    }

    if (cfg.kind === 'smtp' && cfg.smtp && from) {
      const transporter = nodemailer.createTransport({
        host: cfg.smtp.host,
        port: cfg.smtp.port,
        secure: cfg.smtp.secure,
        auth:
          cfg.smtp.user && cfg.smtp.password
            ? { user: cfg.smtp.user, pass: cfg.smtp.password }
            : undefined,
        // Nodemailer's default connection timeout is 2 MINUTES — longer
        // than the platform gateway's ~60s, so a misconfigured host (wrong
        // hostname, filtered port) surfaced as an opaque 504 instead of
        // our clean ETIMEDOUT/ECONNREFUSED error, and a real send (partner
        // invite, signup) could pin its request just as long. Fail fast:
        // a healthy SMTP handshake completes in single-digit seconds.
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        socketTimeout: 30_000,
      });
      await transporter.sendMail({
        from,
        to: msg.to,
        replyTo,
        subject: msg.subject,
        text: msg.text,
        html: msg.html,
        headers: msg.tag ? { 'X-Tag': msg.tag } : undefined,
      });
      return;
    }
    if (cfg.kind === 'postmark' && cfg.postmark && from) {
      const res = await fetch('https://api.postmarkapp.com/email', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          'X-Postmark-Server-Token': cfg.postmark.serverToken,
        },
        body: JSON.stringify({
          From: from,
          To: msg.to,
          ReplyTo: replyTo,
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
