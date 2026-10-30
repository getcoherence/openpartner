/**
 * Partnership signals on creators the Network lists before they join
 * (openpartner-network docs/creator-index.md §3.7): why we think a creator
 * takes brand partnerships. Brands get the kind and a count; ops and the
 * creator also get the page it was read from.
 */

export type PartnershipSignalKind = 'storefront' | 'sponsor_page' | 'sponsored_posts' | 'paid_placement' | 'profile_offer';

export interface PartnershipSignal {
  kind: PartnershipSignalKind;
  count: number | null;
  /** The public page it was read from. Never sent to brands. */
  evidence?: string | null;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** As a brand reads it on a creator's card. */
export function brandSignalLabel(s: PartnershipSignal): string {
  switch (s.kind) {
    case 'storefront':
      return s.count ? `Sells sponsorships (${plural(s.count, 'past collaboration')})` : 'Sells sponsorships';
    case 'sponsor_page':
      return 'Has a sponsor page';
    case 'sponsored_posts':
      return s.count ? `${plural(s.count, 'sponsored post')} lately` : 'Posts sponsored content';
    case 'paid_placement':
      return s.count ? `${plural(s.count, 'paid placement')} on YouTube lately` : 'Paid placements on YouTube';
    case 'profile_offer':
      return 'Invites brand partnerships';
    default:
      return 'Open to partnerships';
  }
}

/** As the creator reads it, in "what we hold". */
export function creatorSignalLabel(s: PartnershipSignal): string {
  switch (s.kind) {
    case 'storefront':
      return 'your sponsorship storefront';
    case 'sponsor_page':
      return 'your sponsor page';
    case 'sponsored_posts':
      return s.count ? `${plural(s.count, 'recent post')} marked as sponsored` : 'recent posts marked as sponsored';
    case 'paid_placement':
      return s.count ? `${plural(s.count, 'recent video')} marked as paid placement` : 'recent videos marked as paid placement';
    case 'profile_offer':
      return 'your profile saying you take partnerships';
    default:
      return 'your public pages';
  }
}

/** "jo.co/sponsor" for a link's text. */
export function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host.replace(/^www\./, '')}${u.pathname === '/' ? '' : u.pathname}`;
  } catch {
    return url;
  }
}
