/**
 * Pure-unit coverage for the brand-approval building blocks — no DB, always
 * runs. The route-matching + email parsing are the bits most likely to
 * silently drift (a renamed route, a bad @-split), so pin them here.
 */

import { describe, expect, it } from 'vitest';
import { isGoLiveRoute } from '../middleware/approval-gate.js';
import { emailDomain, normalizeEmail } from '../brand-review.js';

describe('isGoLiveRoute', () => {
  it('gates the go-live write actions', () => {
    expect(isGoLiveRoute('POST', '/partners')).toBe(true);
    expect(isGoLiveRoute('POST', '/partner-signup')).toBe(true);
    expect(isGoLiveRoute('POST', '/import/partners-csv')).toBe(true);
    expect(isGoLiveRoute('POST', '/admin/network/offerings')).toBe(true);
    expect(isGoLiveRoute('POST', '/admin/network/requests/req_123/approve')).toBe(true);
    expect(isGoLiveRoute('POST', '/admin/network/offerings/off_1/invite-creator')).toBe(true);
    // Paying a bonus moves money to a partner.
    expect(isGoLiveRoute('POST', '/bonuses')).toBe(true);
    expect(isGoLiveRoute('POST', '/Bonuses/')).toBe(true);
    expect(isGoLiveRoute('GET', '/bonuses')).toBe(false);
    // Storefront outreach: booking or messaging a creator first, and
    // tracking a booking (adds a partner). Answering, paying and approving in
    // a conversation the brand's own claimed request opened stay open.
    expect(isGoLiveRoute('POST', '/admin/network/bookings')).toBe(true);
    expect(isGoLiveRoute('POST', '/admin/network/conversations')).toBe(true);
    expect(isGoLiveRoute('POST', '/admin/network/bookings/bkr_1/track')).toBe(true);
    expect(isGoLiveRoute('POST', '/admin/network/conversations/cnv_1/messages')).toBe(false);
    expect(isGoLiveRoute('POST', '/admin/network/bookings/claim')).toBe(false);
    expect(isGoLiveRoute('POST', '/admin/network/bookings/bkr_1/checkout')).toBe(false);
    expect(isGoLiveRoute('POST', '/admin/network/bookings/bkr_1/approve')).toBe(false);
    expect(isGoLiveRoute('POST', '/admin/network/bookings/bkr_1/cancel')).toBe(false);
    expect(isGoLiveRoute('GET', '/admin/network/bookings')).toBe(false);
  });

  it('cannot be bypassed with case or a trailing slash (Express routes both)', () => {
    expect(isGoLiveRoute('POST', '/partners/')).toBe(true);
    expect(isGoLiveRoute('POST', '/Partners')).toBe(true);
    expect(isGoLiveRoute('POST', '/Admin/Network/Offerings/')).toBe(true);
    expect(isGoLiveRoute('POST', '/admin/network/requests/REQ_1/APPROVE//')).toBe(true);
    expect(isGoLiveRoute('post', '/partner-signup')).toBe(true);
  });

  it('gates re-federating under a new vendor identity', () => {
    expect(isGoLiveRoute('POST', '/config/network/start-connect')).toBe(true);
    expect(isGoLiveRoute('POST', '/config/network/complete-connect')).toBe(true);
    expect(isGoLiveRoute('POST', '/config/network', { vendorToken: 'vntok_x' })).toBe(true);
    expect(isGoLiveRoute('POST', '/config/network', { networkUrl: 'https://other.example' })).toBe(true);
    // Turning membership off / toggling autoEnroll is just configuration.
    expect(isGoLiveRoute('POST', '/config/network', { enabled: false })).toBe(false);
    expect(isGoLiveRoute('POST', '/config/network', { autoEnroll: true, networkUrl: '' })).toBe(false);
  });

  it('leaves configuration + reads open', () => {
    // Creating a program / setting branding is configuration, not going live.
    // (Its marketplace offering is synced, but the Network keeps it out of
    // discovery until the brand's review is approved.)
    expect(isGoLiveRoute('POST', '/programs')).toBe(false);
    expect(isGoLiveRoute('PATCH', '/admin/network/offerings/off_1')).toBe(false);
    expect(isGoLiveRoute('POST', '/config/program')).toBe(false);
    // Reads are never gated.
    expect(isGoLiveRoute('GET', '/partners')).toBe(false);
    // A partner-scoped subpath must not be caught by the /partners rule.
    expect(isGoLiveRoute('POST', '/partners/p_1/coupons')).toBe(false);
  });
});

describe('email parsing', () => {
  it('normalizes case + whitespace', () => {
    expect(normalizeEmail('  Danny@YouPlusJuice.com ')).toBe('danny@youplusjuice.com');
  });

  it('extracts the domain', () => {
    expect(emailDomain('danny@youplusjuice.com')).toBe('youplusjuice.com');
    expect(emailDomain('a@b@evil.test')).toBe('evil.test'); // last @ wins
  });

  it('returns null for a malformed address', () => {
    expect(emailDomain('no-at-sign')).toBeNull();
    expect(emailDomain('trailing@')).toBeNull();
  });
});
