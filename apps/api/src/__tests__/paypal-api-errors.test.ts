import { describe, expect, it } from 'vitest';
import { PaypalApiError } from '../paypal-api.js';

describe('PaypalApiError.summary', () => {
  it('names the field and issue PayPal refused, never the value sent', () => {
    const err = new PaypalApiError('http', 400, 'INVALID_REQUEST', 'Request is not well-formed, syntactically incorrect, or violates schema.', 'f903680811425', {
      details: [{ field: 'page_size', value: '300', location: 'query', issue: 'must be less than or equal to 100' }],
    });
    expect(err.summary).toBe(
      'INVALID_REQUEST · Request is not well-formed, syntactically incorrect, or violates schema. · page_size: must be less than or equal to 100 · debug_id f903680811425',
    );
    expect(err.summary).not.toContain('300');
  });

  it('reads the same without details', () => {
    expect(new PaypalApiError('http', 422, 'INSUFFICIENT_FUNDS', 'Not enough funds.', null, {}).summary).toBe('INSUFFICIENT_FUNDS · Not enough funds.');
    expect(new PaypalApiError('network', null, null, 'timed out', null, null).summary).toBe('timed out');
  });
});
