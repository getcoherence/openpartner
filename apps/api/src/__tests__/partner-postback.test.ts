import { describe, expect, it } from 'vitest';
import { substituteMacros } from '../partner-postback.js';

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
});
