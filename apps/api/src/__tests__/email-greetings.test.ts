import { describe, expect, it } from 'vitest';
import * as templates from '../email-templates.js';

const url = 'https://example.test/admin';

/** Mail to a brand's own admins, built for `brandName` (null = unknown). */
const brandAdminEmails = (brandName: string | null) => [
  templates.partnerApplicationAdminEmail('Partner', 'p@example.test', brandName, url),
  templates.campaignEndingBrandEmail(brandName, 'Campaign', new Date('2026-10-18T00:00:00Z'), url),
  templates.paypalBatchAttentionEmail({
    brandName,
    kind: 'failed',
    environment: 'live',
    batchId: 'B1',
    lastError: null,
    items: [],
    payoutsUrl: url,
  }),
  templates.trackingFlagsEmail(brandName, { checks: ['Spring: no partners yet.'], flags: [] }, url),
];

describe('brand admin email greetings', () => {
  it.each(brandAdminEmails('Acme'))('greets the brand team, not "from" the brand: $subject', (message) => {
    expect(message.text.split('\n')[0]).toBe('Hi Acme team,');
    expect(message.text).not.toContain('Hi from');
  });

  it.each(brandAdminEmails(null))('says "Hi there" without a brand name: $subject', (message) => {
    expect(message.text.split('\n')[0]).toBe('Hi there,');
  });
});
