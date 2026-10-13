import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Knex } from 'knex';
import { TABLES } from '@openpartner/db';
import * as templates from '../email-templates.js';
import { brandEmailHtml } from '../email-branding.js';
import { getMailer } from '../mailer.js';
import { resolveMailConfig } from '../mail-settings.js';
import nodemailer from 'nodemailer';

vi.mock('../mail-settings.js', () => ({ resolveMailConfig: vi.fn() }));
vi.mock('nodemailer', () => ({ default: { createTransport: vi.fn() } }));

afterEach(() => vi.restoreAllMocks());

const url = 'https://example.test/auth/magic?token=test';
const date = new Date('2026-10-18T00:00:00Z');
const messages = [
  templates.partnerInviteEmail('Partner', url),
  templates.partnerSigninEmail('Partner', url),
  templates.adminInviteEmail('Admin', url, 'Brand'),
  templates.adminSigninEmail('Admin', url),
  templates.partnerRevokedEmail('Partner', 'Reason'),
  templates.campaignEndingBrandEmail('Brand', 'Campaign', date, url),
  templates.campaignEndingPartnerEmail('Partner', 'Brand', 'Campaign', date, url),
  templates.brandApprovedEmail('Admin', 'Brand', url),
  templates.brandRejectedEmail('Brand', 'Reason'),
  templates.platformAdminSigninEmail(url),
  templates.opsBrandNeedsReviewEmail('Brand', 'brand', 'admin@example.test', url),
  templates.opsBrandDecisionEmail('Brand', 'brand', 'approved', 'ops@example.test', null),
  templates.opsTenantCancellationScheduledEmail('Brand', 'brand', date, null, url),
  templates.opsTenantCancellationResumedEmail('Brand', 'brand'),
  templates.opsTenantSubscriptionEndedEmail('Brand', 'brand', 'webhook', false),
  templates.opsTenantInvoicePaymentFailedEmail('Brand', 'brand', 'EUR 10', 1, url),
  templates.opsTenantInvoicePaymentFailedEmail('Brand', 'brand', 'EUR 10', 1, null),
];

describe('email branding', () => {
  it.each(messages)('brands every template: $subject', (message) => {
    const html = brandEmailHtml(message.html, '#123456');
    expect(html).toContain('border-top:4px solid #123456');
    expect(html).not.toContain('data-op-email=');
    if (message.html.includes('data-op-email="button"')) {
      expect(html).toContain('background:#123456; color:#ffffff');
      expect(html).toContain('color:#123456');
      expect(html).toContain(url);
    }
  });

  it.each([null, '', '#12345', 'red', '#ffffff; background:url(evil)', '"><script>evil</script>'])('falls back safely for %s', (color) => {
      expect(brandEmailHtml(messages[0]!.html, color)).toContain('background:#2dd4bf; color:#000000');
    });

  it('expands shorthand and uses dark ink and readable links for light accents', () => {
    const html = brandEmailHtml(messages[0]!.html, ' #fff ');
    expect(html).toContain('background:#ffffff; color:#000000');
    expect(html).toContain('color:#6c6c6c');
  });

  it('strips alpha from the eight-digit color accepted by brand settings', () => {
    expect(brandEmailHtml(messages[0]!.html, '#12345680')).toContain('background:#123456; color:#ffffff');
  });

  it('leaves body text, URLs and unmarked custom HTML unchanged', () => {
    const custom = '<p style="color:#2dd4bf">#041115 https://example.test/#2dd4bf</p>';
    expect(brandEmailHtml(custom, '#123456')).toBe(custom);
  });

  it('only rewrites the marker inside our own tags, not text that contains it', () => {
    // e.g. a partner named `data-op-email="card" style="x"`, HTML-escaped into the body.
    const html = templates.partnerInviteEmail('data-op-email="card" style="x"', url).html;
    const branded = brandEmailHtml(html, '#123456');
    expect(branded).toContain('data-op-email="card" style="x"');
    expect(branded).toContain('border-top:4px solid #123456');
  });

  it.each(['smtp', 'postmark'] as const)('uses fresh tenant colors on %s sends, including text-only messages', async (kind) => {
    const sendMail = vi.fn().mockResolvedValue({});
    vi.mocked(nodemailer.createTransport).mockReturnValue({ sendMail } as unknown as ReturnType<typeof nodemailer.createTransport>);
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, json: async () => ({ ErrorCode: 0 }) } as Response);
    vi.mocked(resolveMailConfig).mockResolvedValue({
      source: 'ui', kind, from: 'sender@example.test',
      smtp: { host: 'localhost', port: 1025, secure: false, user: null, password: null },
      postmark: { serverToken: 'dummy', messageStream: 'outbound' },
    });
    let color = '#123456';
    const first = vi.fn(async () => ({ brandColor: color }));
    const where = vi.fn(() => ({ first }));
    const db = vi.fn(() => ({ where })) as unknown as Knex;
    const ctx = { db, tenantId: 'tenant-a' };
    await getMailer().send(ctx, { to: 'recipient@example.test', ...messages[0]! });
    color = '#ffffff';
    await getMailer().send(ctx, { to: 'recipient@example.test', subject: 'Test', text: 'Plain <text>' });
    const delivered = kind === 'smtp'
      ? sendMail.mock.calls.map(([message]) => message.html as string)
      : fetchMock.mock.calls.map(([, options]) => (JSON.parse(options!.body as string) as { HtmlBody: string }).HtmlBody);
    expect(delivered[0]).toContain('background:#123456');
    expect(delivered[1]).toContain('border-top:4px solid #ffffff');
    expect(delivered[1]).toContain('Plain &lt;text&gt;');
    expect(db).toHaveBeenCalledWith(TABLES.Tenant);
    expect(where).toHaveBeenCalledWith({ id: 'tenant-a' });
  });

  it('never brands platform-voice mail, whatever tenant the send runs under', async () => {
    const sendMail = vi.fn().mockResolvedValue({});
    vi.mocked(nodemailer.createTransport).mockReturnValue({ sendMail } as unknown as ReturnType<typeof nodemailer.createTransport>);
    vi.mocked(resolveMailConfig).mockResolvedValue({
      source: 'ui', kind: 'smtp', from: 'sender@example.test',
      smtp: { host: 'localhost', port: 1025, secure: false, user: null, password: null },
      postmark: { serverToken: 'dummy', messageStream: 'outbound' },
    });
    const first = vi.fn(async () => ({ brandColor: '#123456' }));
    const db = vi.fn(() => ({ where: vi.fn(() => ({ first })) })) as unknown as Knex;
    await getMailer().send({ db, tenantId: 'tenant-a' }, { to: 'recipient@example.test', ...messages[3]!, platform: true });
    const html = sendMail.mock.calls[0]![0].html as string;
    expect(html).not.toContain('#123456');
    expect(html).toContain('background:#2dd4bf');
    expect(first).not.toHaveBeenCalled();
  });
});
