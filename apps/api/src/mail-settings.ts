/**
 * Mail transport configuration, stored in Config under 'mail_settings'.
 *
 * SMTP password and Postmark server token are AES-GCM encrypted at rest
 * using SECRETS_ENCRYPTION_KEY. Everything else (host, port, from,
 * username) is stored plaintext — they're identifiers, not secrets.
 *
 * Resolution order at dispatch time:
 *   1. UI-configured settings for the calling tenant (if any, and not partially blank)
 *   2. Env vars (SMTP_HOST / POSTMARK_SERVER_TOKEN + MAIL_FROM)
 *   3. Console fallback
 *
 * The UI always wins over env, so an admin editing from the portal can
 * rotate creds without a redeploy. Hosted deployments that want to
 * force env can simply leave the UI empty.
 *
 * Multi-tenant: every read/write is scoped to a tenantId. Each tenant has
 * its own (encrypted) UI mail config; env fallback is shared platform-wide.
 */

import type { Knex } from 'knex';
import { TABLES, type ConfigRow } from '@openpartner/db';
import { decryptSecret, encryptSecret } from './crypto.js';

export type MailTransportKind = 'smtp' | 'postmark' | 'none';

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string | null;
  /** Decrypted plaintext. Never serialize this to JSON clients. */
  password: string | null;
}

export interface PostmarkConfig {
  serverToken: string;
  messageStream: string;
}

export interface ResolvedMailConfig {
  kind: MailTransportKind;
  from: string | null;
  smtp?: SmtpConfig;
  postmark?: PostmarkConfig;
  source: 'ui' | 'env' | 'none';
}

// ---------- on-disk shapes ----------

interface StoredMailSettings {
  kind: MailTransportKind | null;
  from: string | null;
  smtp?: {
    host: string;
    port: number;
    secure: boolean;
    user: string | null;
    passwordCiphertext: string | null;
  } | null;
  postmark?: {
    serverTokenCiphertext: string;
    messageStream: string;
  } | null;
}

const CONFIG_KEY = 'mail_settings';

// ---------- read ----------

async function readStored(db: Knex, tenantId: string): Promise<StoredMailSettings | null> {
  const row = await db<ConfigRow>(TABLES.Config).where({ tenantId, key: CONFIG_KEY }).first();
  return (row?.value as StoredMailSettings | undefined) ?? null;
}

/** Sanitized payload for the admin UI — no ciphertexts, no plaintext secrets. */
export interface PublicMailSettings {
  kind: MailTransportKind | null;
  from: string | null;
  smtp: { host: string; port: number; secure: boolean; user: string | null; hasPassword: boolean } | null;
  postmark: { hasToken: boolean; messageStream: string } | null;
}

export async function getPublicMailSettings(db: Knex, tenantId: string): Promise<PublicMailSettings> {
  const stored = await readStored(db, tenantId);
  if (!stored) return { kind: null, from: null, smtp: null, postmark: null };
  return {
    kind: stored.kind,
    from: stored.from,
    smtp: stored.smtp
      ? {
          host: stored.smtp.host,
          port: stored.smtp.port,
          secure: stored.smtp.secure,
          user: stored.smtp.user,
          hasPassword: !!stored.smtp.passwordCiphertext,
        }
      : null,
    postmark: stored.postmark
      ? { hasToken: !!stored.postmark.serverTokenCiphertext, messageStream: stored.postmark.messageStream }
      : null,
  };
}

/** Decrypted + usable by the mailer. Never hand to an HTTP client. */
export async function resolveMailConfig(db: Knex, tenantId: string): Promise<ResolvedMailConfig> {
  const stored = await readStored(db, tenantId);
  if (stored?.kind === 'smtp' && stored.from && stored.smtp) {
    return {
      kind: 'smtp',
      from: stored.from,
      smtp: {
        host: stored.smtp.host,
        port: stored.smtp.port,
        secure: stored.smtp.secure,
        user: stored.smtp.user,
        password: stored.smtp.passwordCiphertext ? decryptSecret(stored.smtp.passwordCiphertext) : null,
      },
      source: 'ui',
    };
  }
  if (stored?.kind === 'postmark' && stored.from && stored.postmark) {
    return {
      kind: 'postmark',
      from: stored.from,
      postmark: {
        serverToken: decryptSecret(stored.postmark.serverTokenCiphertext),
        messageStream: stored.postmark.messageStream,
      },
      source: 'ui',
    };
  }

  // Fallback to env.
  const from = process.env.MAIL_FROM ?? null;
  const smtpHost = process.env.SMTP_HOST;
  const postmarkToken = process.env.POSTMARK_SERVER_TOKEN;
  if (smtpHost && from) {
    return {
      kind: 'smtp',
      from,
      smtp: {
        host: smtpHost,
        port: Number(process.env.SMTP_PORT ?? 587),
        secure: process.env.SMTP_SECURE === '1' || process.env.SMTP_PORT === '465',
        user: process.env.SMTP_USER ?? null,
        password: process.env.SMTP_PASSWORD ?? null,
      },
      source: 'env',
    };
  }
  if (postmarkToken && from) {
    return {
      kind: 'postmark',
      from,
      postmark: {
        serverToken: postmarkToken,
        messageStream: process.env.POSTMARK_MESSAGE_STREAM ?? 'outbound',
      },
      source: 'env',
    };
  }
  return { kind: 'none', from: null, source: 'none' };
}

// ---------- write ----------

/**
 * Write an input shape from the UI. Fields left blank / null mean
 * "keep the existing stored value" for secrets, "clear" for everything
 * else. This lets an admin rotate only the password without re-entering
 * it.
 */
export interface MailSettingsInput {
  kind: MailTransportKind | null;
  from?: string | null;
  smtp?: {
    host?: string | null;
    port?: number | null;
    secure?: boolean | null;
    user?: string | null;
    /** New plaintext password. Leave undefined to keep existing. */
    password?: string | null;
  } | null;
  postmark?: {
    /** New plaintext token. Leave undefined to keep existing. */
    serverToken?: string | null;
    messageStream?: string | null;
  } | null;
}

export class MailSettingsValidationError extends Error {
  constructor(public readonly code: string, public readonly field?: string) {
    super(code);
  }
}

export async function saveMailSettings(
  db: Knex,
  tenantId: string,
  input: MailSettingsInput,
): Promise<void> {
  const current = (await readStored(db, tenantId)) ?? ({ kind: null, from: null } as StoredMailSettings);

  const next: StoredMailSettings = {
    kind: input.kind ?? current.kind,
    from: input.from !== undefined ? (input.from || null) : current.from,
  };

  if (next.kind === 'smtp') {
    const prevSmtp = current.smtp ?? null;
    const s = input.smtp ?? null;
    const host = s?.host ?? prevSmtp?.host ?? '';
    // Saving kind='smtp' without a host would succeed silently and
    // then blow up at first email. Reject at the boundary.
    if (!host.trim()) throw new MailSettingsValidationError('smtp_host_required', 'smtp.host');
    if (!next.from) throw new MailSettingsValidationError('from_required', 'from');
    const rotated = s?.password !== undefined && s.password !== '';
    next.smtp = {
      host,
      port: s?.port ?? prevSmtp?.port ?? 587,
      secure: s?.secure ?? prevSmtp?.secure ?? false,
      user: s?.user ?? prevSmtp?.user ?? null,
      passwordCiphertext: rotated
        ? (s!.password === null ? null : encryptSecret(s!.password as string))
        : prevSmtp?.passwordCiphertext ?? null,
    };
    next.postmark = null;
  } else if (next.kind === 'postmark') {
    const prevPm = current.postmark ?? null;
    const p = input.postmark ?? null;
    const rotated = p?.serverToken !== undefined && p.serverToken !== '';
    const token = rotated ? encryptSecret(p!.serverToken as string) : prevPm?.serverTokenCiphertext;
    if (!token) throw new MailSettingsValidationError('postmark_server_token_required', 'postmark.serverToken');
    if (!next.from) throw new MailSettingsValidationError('from_required', 'from');
    next.postmark = {
      serverTokenCiphertext: token,
      messageStream: p?.messageStream ?? prevPm?.messageStream ?? 'outbound',
    };
    next.smtp = null;
  } else {
    // kind = 'none' or null — clear creds, keep from if user wants to pre-set it.
    next.smtp = null;
    next.postmark = null;
  }

  const now = new Date();
  await db<ConfigRow>(TABLES.Config)
    .insert({ tenantId, key: CONFIG_KEY, value: next as unknown as never, updatedAt: now })
    .onConflict(['tenantId', 'key'])
    .merge({ value: next as unknown as never, updatedAt: now });
}
