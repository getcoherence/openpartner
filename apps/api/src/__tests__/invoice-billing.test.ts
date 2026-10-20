/**
 * Pay-by-invoice terms (docs/invoice-billing.md) — DB-free tier.
 *
 * Pins: which way a tenant pays (ops choice, then the declared-country
 * default, then a card), that an Indian brand on invoices needs a GSTIN,
 * and that a GSTIN's check character is verified — Stripe only checks an
 * in_gst tax ID's shape.
 */

import { describe, expect, it } from 'vitest';
import {
  collectionTerms,
  DAYS_UNTIL_DUE_DEFAULT,
  INVOICE_PAYMENT_SETTINGS,
  normalizeGstin,
  sendInvoiceParams,
} from '../invoice-billing.js';
import { INVOICE_GRACE_DAYS_DEFAULT } from '../billing-plan.js';

describe('normalizeGstin', () => {
  it('accepts a valid GSTIN and canonicalizes case and spacing', () => {
    expect(normalizeGstin('27AAPFU0939F1ZV')).toBe('27AAPFU0939F1ZV');
    expect(normalizeGstin(' 27aapfu0939f1zv ')).toBe('27AAPFU0939F1ZV');
    expect(normalizeGstin('27-AAPFU0939F-1ZV')).toBe('27AAPFU0939F1ZV');
  });

  it('rejects a wrong check character (a one-character typo)', () => {
    expect(normalizeGstin('27AAPFU0939F1ZW')).toBeNull();
    expect(normalizeGstin('27AAPFU0939F2ZV')).toBeNull();
  });

  it('rejects anything not shaped like a GSTIN', () => {
    expect(normalizeGstin('')).toBeNull();
    expect(normalizeGstin('27AAPFU0939F1Z')).toBeNull();
    expect(normalizeGstin('AAPFU0939F')).toBeNull(); // a bare PAN
    expect(normalizeGstin('2XAAPFU0939F1ZV')).toBeNull();
  });
});

describe('collectionTerms', () => {
  const settings = { defaultCountries: ['IN'] };

  it('defaults a brand that declared a listed country to invoices, needing a GSTIN in India', () => {
    expect(collectionTerms(null, 'IN', settings)).toEqual({
      method: 'send_invoice',
      source: 'country',
      daysUntilDue: DAYS_UNTIL_DUE_DEFAULT,
      graceDays: INVOICE_GRACE_DAYS_DEFAULT,
      country: 'IN',
      gstin: null,
      gstinRequired: true,
    });
  });

  it('leaves everyone else on a card', () => {
    expect(collectionTerms(null, 'US', settings)).toMatchObject({ method: 'charge_automatically', source: 'default', gstinRequired: false });
    expect(collectionTerms(null, null, settings)).toMatchObject({ method: 'charge_automatically', source: 'default' });
    expect(collectionTerms(null, 'IN', { defaultCountries: [] })).toMatchObject({ method: 'charge_automatically' });
  });

  it('an ops choice wins over the country default, both ways', () => {
    const base = { daysUntilDue: 30, graceDays: 10, gstin: null };
    expect(collectionTerms({ ...base, collectionMethod: 'send_invoice' }, 'US', settings)).toMatchObject({
      method: 'send_invoice',
      source: 'ops',
      daysUntilDue: 30,
      graceDays: 10,
      gstinRequired: false,
    });
    expect(collectionTerms({ ...base, collectionMethod: 'charge_automatically' }, 'IN', settings)).toMatchObject({
      method: 'charge_automatically',
      source: 'ops',
      gstinRequired: false,
    });
    // A profile row with no choice (only a GSTIN) follows the default.
    expect(collectionTerms({ ...base, collectionMethod: null, gstin: '27AAPFU0939F1ZV' }, 'IN', settings)).toMatchObject({
      method: 'send_invoice',
      source: 'country',
      gstin: '27AAPFU0939F1ZV',
    });
  });
});

describe('send_invoice subscription params', () => {
  it('offers card and bank transfer (US bank transfer, which takes SWIFT wires)', () => {
    expect(sendInvoiceParams(15)).toEqual({
      collection_method: 'send_invoice',
      days_until_due: 15,
      payment_settings: INVOICE_PAYMENT_SETTINGS,
    });
    expect(INVOICE_PAYMENT_SETTINGS).toEqual({
      payment_method_types: ['card', 'customer_balance'],
      payment_method_options: {
        customer_balance: { funding_type: 'bank_transfer', bank_transfer: { type: 'us_bank_transfer' } },
      },
    });
  });
});
