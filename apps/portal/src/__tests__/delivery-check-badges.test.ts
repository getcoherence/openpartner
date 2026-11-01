import { describe, it, expect } from 'vitest';
import { urlBadges, type DeliveryUrlCheck } from '../pages/admin/DeliveryChecks.js';

const youtube: DeliveryUrlCheck = {
  url: 'https://youtu.be/dQw4w9WgXcQ',
  platform: 'youtube',
  label: 'YouTube',
  account: 'unverified',
  trackedLink: 'unknown',
  reachable: null,
  publishedAt: null,
  publishedBeforeAccept: null,
  duplicates: [],
  views: null,
  error: null,
};

describe('urlBadges', () => {
  it('says why a YouTube post went unchecked when the creator is deleting their account', () => {
    expect(urlBadges({ ...youtube, error: 'creator_deleting' })).toEqual([
      { tone: 'neutral', text: 'Couldn’t check: The creator is deleting their account' },
    ]);
  });

  it('still flags a duplicate post beside it', () => {
    const badges = urlBadges({ ...youtube, error: 'creator_deleting', duplicates: [{ bookingId: 'bkr_1', sameBrand: true }] });
    expect(badges.map((b) => b.text)).toEqual([
      'Also delivered for another of your bookings',
      'Couldn’t check: The creator is deleting their account',
    ]);
  });
});
