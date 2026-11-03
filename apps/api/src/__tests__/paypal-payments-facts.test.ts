/**
 * PayPal payloads into payment facts (paypal-payments.ts), from the shapes
 * in PayPal's webhook and Transaction Search references. No database.
 */

import { describe, expect, it } from 'vitest';
import { ulid } from 'ulid';
import { clickReferences, factFromTransaction, factFromWebhookEvent, factKey } from '../paypal-payments.js';

describe('the click reference', () => {
  it('is the whole custom_id, or a click id beside the brand’s own reference', () => {
    const click = ulid();
    expect(clickReferences(click)).toEqual([click]);
    expect(clickReferences(click.toLowerCase())).toEqual([click]);
    expect(clickReferences(`order-1042|${click}`)).toEqual([click]);
    expect(clickReferences(`order-1042 ${click}`)).toEqual([click]);
    expect(clickReferences('order-1042')).toEqual([]);
    expect(clickReferences(`X${click}`)).toEqual([]);
    expect(clickReferences(null)).toEqual([]);
  });
});

describe('webhook events', () => {
  it('reads a completed capture, and skips one still pending', () => {
    const event = {
      event_type: 'PAYMENT.CAPTURE.COMPLETED',
      create_time: '2026-11-01T10:00:00Z',
      resource: {
        id: '2GG279541U471931P',
        status: 'COMPLETED',
        amount: { currency_code: 'usd', value: '10.50' },
        custom_id: 'abc',
        invoice_id: 'never-read',
        supplementary_data: { related_ids: { order_id: '5O190127TN364715T' } },
        create_time: '2026-11-01T09:59:58Z',
      },
    };
    const fact = factFromWebhookEvent(event);
    expect(fact).toEqual({
      kind: 'capture',
      id: '2GG279541U471931P',
      amount: { value: '10.50', currency: 'USD' },
      customId: 'abc',
      orderId: '5O190127TN364715T',
      at: new Date('2026-11-01T09:59:58Z'),
    });
    expect(factKey(fact!)).toBe('capture:2GG279541U471931P');
    expect(factFromWebhookEvent({ ...event, resource: { ...event.resource, status: 'PENDING' } })).toBeNull();
    expect(factFromWebhookEvent({ ...event, resource: { ...event.resource, amount: { currency_code: 'USD', value: '1e9' } } })).toBeNull();
  });

  it('reads a sale’s subscription, a refund’s payment and a dispute’s transactions', () => {
    expect(
      factFromWebhookEvent({
        event_type: 'PAYMENT.SALE.COMPLETED',
        resource: { id: '80021663DE681814L', state: 'completed', amount: { total: '49.00', currency: 'USD' }, billing_agreement_id: 'I-PE7JWXKGVN0R' },
      }),
    ).toMatchObject({ kind: 'sale', subscriptionId: 'I-PE7JWXKGVN0R', amount: { value: '49.00' } });
    expect(
      factFromWebhookEvent({
        event_type: 'PAYMENT.CAPTURE.REFUNDED',
        resource: {
          id: '1JU08902781691411',
          status: 'COMPLETED',
          amount: { value: '5.00', currency_code: 'USD' },
          links: [{ rel: 'up', href: 'https://api.paypal.com/v2/payments/captures/2GG279541U471931P', method: 'GET' }],
        },
      }),
    ).toMatchObject({ kind: 'refund', paymentId: '2GG279541U471931P' });
    expect(
      factFromWebhookEvent({ event_type: 'PAYMENT.SALE.REFUNDED', resource: { id: 'R1', state: 'completed', sale_id: 'S1', amount: { total: '1.00', currency: 'USD' } } }),
    ).toMatchObject({ kind: 'refund', paymentId: 'S1' });
    expect(
      factFromWebhookEvent({
        event_type: 'CUSTOMER.DISPUTE.CREATED',
        resource: { dispute_id: 'PP-D-1', disputed_transactions: [{ seller_transaction_id: 'T1' }, {}], dispute_amount: { value: '3.00', currency_code: 'EUR' } },
      }),
    ).toMatchObject({ kind: 'dispute', transactionIds: ['T1'], amount: { value: '3.00', currency: 'EUR' } });
    const activated = factFromWebhookEvent({ event_type: 'BILLING.SUBSCRIPTION.ACTIVATED', resource: { id: 'I-1', custom_id: 'c', plan_id: 'P-1' } });
    expect(activated).toMatchObject({ kind: 'subscription', activated: true, customId: 'c' });
    expect(factKey(activated!)).toBe('subscription_activated:I-1');
    expect(factFromWebhookEvent({ event_type: 'PAYMENT.PAYOUTSBATCH.SUCCESS', resource: {} })).toBeNull();
  });
});

describe('Transaction Search rows', () => {
  const row = (o: Record<string, unknown>) => ({
    transaction_id: 'T1',
    transaction_status: 'S',
    transaction_initiation_date: '2026-11-01T10:00:00+0000',
    transaction_amount: { currency_code: 'USD', value: '10.00' },
    ...o,
  });

  it('reads payments received, subscription payments and refunds; skips the rest', () => {
    expect(factFromTransaction(row({ transaction_event_code: 'T0006', custom_field: 'abc', paypal_reference_id: 'O1', paypal_reference_id_type: 'ODR' }))).toMatchObject({
      kind: 'capture',
      customId: 'abc',
      orderId: 'O1',
    });
    expect(factFromTransaction(row({ transaction_event_code: 'T0002', paypal_reference_id: 'I-9', paypal_reference_id_type: 'SUB' }))).toMatchObject({
      kind: 'sale',
      subscriptionId: 'I-9',
    });
    expect(
      factFromTransaction(row({ transaction_event_code: 'T1107', transaction_amount: { currency_code: 'USD', value: '-4.00' }, paypal_reference_id: 'T0', paypal_reference_id_type: 'TXN' })),
    ).toMatchObject({ kind: 'refund', paymentId: 'T0', amount: { value: '4.00' } });
    expect(factFromTransaction(row({ transaction_event_code: 'T0006', transaction_status: 'P' }))).toBeNull();
    expect(factFromTransaction(row({ transaction_event_code: 'T0001', transaction_amount: { currency_code: 'USD', value: '-10.00' } }))).toBeNull();
    expect(factFromTransaction(row({ transaction_event_code: 'T0400' }))).toBeNull();
  });
});
