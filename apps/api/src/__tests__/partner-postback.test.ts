import { describe, expect, it } from 'vitest';
import { postbackStatus, substituteMacros } from '../partner-postback.js';

describe('substituteMacros', () => {
  it('replaces known macros with URL-encoded values', () => {
    const out = substituteMacros(
      'https://t.example/?cid={click_id}&amt={commission_amount}&cur={currency}',
      { click_id: '01J123', commission_amount: '12.50', currency: 'USD' },
    );
    expect(out).toBe('https://t.example/?cid=01J123&amt=12.50&cur=USD');
  });

  it('URL-encodes values that contain reserved characters', () => {
    const out = substituteMacros('https://t.example/?eid={event_id}', {
      event_id: 'evt with spaces & ampersand',
    });
    expect(out).toBe('https://t.example/?eid=evt%20with%20spaces%20%26%20ampersand');
  });

  it('leaves unknown macros literal so misspellings are visible', () => {
    const out = substituteMacros('https://t.example/?x={typo_id}&y={click_id}', {
      click_id: 'abc',
    });
    expect(out).toBe('https://t.example/?x={typo_id}&y=abc');
  });

  it('substitutes transaction_id alias when provided', () => {
    const out = substituteMacros('https://t.example/?tid={transaction_id}', {
      transaction_id: 'evt_42',
    });
    expect(out).toBe('https://t.example/?tid=evt_42');
  });

  it('returns the template unchanged when no macros are present', () => {
    const out = substituteMacros('https://t.example/?fixed=1', {});
    expect(out).toBe('https://t.example/?fixed=1');
  });

  it('substitutes {sub_id}, {status} and {sale_amount}, encoding the sub-ID', () => {
    const out = substituteMacros('https://t.example/?s={sub_id}&st={status}&rev={sale_amount}', {
      sub_id: 'wct 9f&2a',
      status: 'approved',
      sale_amount: '60.00',
    });
    expect(out).toBe('https://t.example/?s=wct%209f%262a&st=approved&rev=60.00');
  });

  it('fills an empty value as empty, not literal', () => {
    const out = substituteMacros('https://t.example/?s={sub_id}&rev={sale_amount}', { sub_id: '', sale_amount: '' });
    expect(out).toBe('https://t.example/?s=&rev=');
  });
});

describe('postbackStatus', () => {
  it('names the status change each commission event announces', () => {
    expect(postbackStatus('commission.accrued')).toBe('pending');
    expect(postbackStatus('commission.approved')).toBe('approved');
    expect(postbackStatus('commission.reversed')).toBe('reversed');
    expect(postbackStatus('commission.paid')).toBe('paid');
  });

  it('follows the bonus: awarded straight to payout is approved, held is pending', () => {
    expect(postbackStatus('bonus.awarded', 'approved')).toBe('approved');
    expect(postbackStatus('bonus.awarded', 'accrued')).toBe('pending');
    expect(postbackStatus('bonus.awarded')).toBe('pending');
    expect(postbackStatus('bonus.paid')).toBe('paid');
  });
});
