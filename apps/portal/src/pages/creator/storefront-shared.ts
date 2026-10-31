/**
 * Shared bits of the creator storefront (the Network's
 * docs/creator-storefront.md): the package and channel shapes, package
 * templates, grouping packages under channels, and how prices and stats read.
 */

export interface StorefrontPackage {
  id: string;
  title: string;
  description: string | null;
  /** A platform kind, or null for "any platform". */
  platform: string | null;
  /** Whole currency units; null = "price on request". */
  priceAmount: number | null;
  priceIsFrom: boolean;
  currency: string;
}

/** The creator's own view adds draft state + order. */
export interface OwnPackage extends StorefrontPackage {
  published: boolean;
  position: number;
}

/**
 * A creator's channel as the storefront shows it: a CreatorPlatform row
 * (the Network's publicPlatformView). The pitch and synced stats are absent
 * on a Network that predates them (§7.2).
 */
export interface StorefrontChannel {
  id: string;
  platform: string;
  handle: string;
  profileUrl: string | null;
  followerCount: number | null;
  verified: boolean;
  /** What the channel covers, in the creator's words. */
  description?: string | null;
  /** How often they publish, e.g. "Weekly". */
  cadence?: string | null;
  /** followerCount (and viewsPerVideo) came from the platform's API. */
  followerCountSynced?: boolean;
  /** Median views of the latest uploads (YouTube). */
  viewsPerVideo?: number | null;
  /** Mean likes and comments of the same uploads, and the engagement rate
   *  they make against the synced count, in percent (verified YouTube). */
  likesPerVideo?: number | null;
  commentsPerVideo?: number | null;
  engagementRate?: number | null;
  engagementPosts?: number | null;
  statsSyncedAt?: string | null;
}

export const PLATFORM_LABELS: Record<string, string> = {
  tiktok: 'TikTok',
  instagram: 'Instagram',
  youtube: 'YouTube',
  twitter: 'X / Twitter',
  linkedin: 'LinkedIn',
  substack: 'Substack',
  twitch: 'Twitch',
  podcast: 'Podcast',
  website: 'Website',
  threads: 'Threads',
  bluesky: 'Bluesky',
  facebook: 'Facebook',
  pinterest: 'Pinterest',
  snapchat: 'Snapchat',
  newsletter: 'Newsletter',
  reddit: 'Reddit',
  discord: 'Discord',
};

/** Currencies offered in the package editor. The Network accepts any ISO
 *  4217 code; this list just keeps the picker short. */
export const PACKAGE_CURRENCIES = ['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'INR', 'JPY', 'BRL', 'MXN', 'SGD'] as const;

/** The Network's cap on a package price, in whole units. */
export const MAX_PACKAGE_PRICE = 10_000_000;

/** A typed price: blank is "on request" (null); otherwise a whole number up
 *  to MAX_PACKAGE_PRICE, or invalid. */
export function parsePackagePrice(raw: string): { valid: boolean; amount: number | null } {
  const v = raw.trim().replace(/,/g, '');
  if (v === '') return { valid: true, amount: null };
  if (!/^\d{1,8}$/.test(v) || Number(v) > MAX_PACKAGE_PRICE) return { valid: false, amount: null };
  return { valid: true, amount: Number(v) };
}

/** "$500", "From €1,199", or "Price on request". Prices are whole units. */
export function formatPackagePrice(p: Pick<StorefrontPackage, 'priceAmount' | 'priceIsFrom' | 'currency'>): string {
  if (p.priceAmount == null) return 'Price on request';
  let amount: string;
  try {
    amount = new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: p.currency,
      maximumFractionDigits: 0,
      minimumFractionDigits: 0,
    }).format(p.priceAmount);
  } catch {
    // An unusual code Intl doesn't know — still readable.
    amount = `${p.priceAmount.toLocaleString('en-US')} ${p.currency}`;
  }
  return p.priceIsFrom ? `From ${amount}` : amount;
}

/** A starting point for a package: the format, never a price. */
export interface PackageTemplate {
  title: string;
  description: string;
}

const NEWSLETTER_TEMPLATES: PackageTemplate[] = [
  { title: 'Primary sponsor', description: 'Top placement in one issue: your logo, about 100 words and a link, above the main story.' },
  { title: 'Secondary sponsor', description: 'A shorter mention lower in one issue: about 50 words and a link.' },
  { title: 'Dedicated email', description: 'A whole issue about your product, sent to my full list.' },
  { title: 'Classified', description: 'A one-line text ad with a link in the classifieds section.' },
];

/** X, Threads and Bluesky: short posts. */
const SHORT_POST_TEMPLATES: PackageTemplate[] = [
  { title: 'Sponsored post', description: 'A post about your product, with your link.' },
  { title: 'Thread', description: 'A thread of 5–10 posts going deeper on your product.' },
  { title: 'Quote post', description: 'A quote of your announcement with my take on it.' },
];

/**
 * Common sponsorship formats per platform, offered when adding a package.
 * The creator edits the wording and sets their own price. `any` is for
 * packages that span channels.
 */
export const PACKAGE_TEMPLATES: Record<string, PackageTemplate[]> = {
  youtube: [
    { title: 'Shoutout', description: 'A 30-second mention of your product in one of my videos, with your link in the description.' },
    { title: 'Integrated sponsorship', description: 'A 60–90 second segment built into the video, with your link at the top of the description.' },
    { title: 'Dedicated video', description: 'A whole video about your product: a review, tutorial or walkthrough, with your link in the description.' },
    { title: 'YouTube Short', description: 'A vertical Short under 60 seconds featuring your product.' },
  ],
  substack: NEWSLETTER_TEMPLATES,
  newsletter: NEWSLETTER_TEMPLATES,
  linkedin: [
    { title: 'Sponsored post', description: 'A post about your product on my profile, in my own voice, with your link.' },
    { title: 'Carousel post', description: 'A multi-slide document post walking through your product.' },
    { title: 'LinkedIn article', description: 'A long-form article about your product or the problem it solves.' },
    { title: 'Repost with comment', description: 'A repost of your company’s post with my take on it.' },
  ],
  twitter: SHORT_POST_TEMPLATES,
  threads: SHORT_POST_TEMPLATES,
  bluesky: SHORT_POST_TEMPLATES,
  facebook: [
    { title: 'Sponsored post', description: 'A post about your product on my page, with your link.' },
    { title: 'Reel', description: 'A short vertical video featuring your product.' },
    { title: 'Group post', description: 'A post about your product in the group I run, with your link.' },
    { title: 'Live stream', description: 'A live session using or talking about your product.' },
  ],
  pinterest: [
    { title: 'Sponsored Pin', description: 'A Pin featuring your product, linking to your site.' },
    { title: 'Video Pin', description: 'A short vertical video Pin featuring your product.' },
    { title: 'Board feature', description: 'Your products pinned to one of my themed boards.' },
  ],
  snapchat: [
    { title: 'Story set', description: 'Snaps featuring your product in my Story, with a link to your site.' },
    { title: 'Spotlight video', description: 'A Spotlight video featuring your product.' },
  ],
  reddit: [
    { title: 'Sponsored post', description: 'A post about your product in my community, flaired as sponsored, with your link.' },
    { title: 'Pinned post', description: 'A sponsored post pinned to the top of my community for a week.' },
    { title: 'AMA', description: 'An Ask Me Anything in my community with someone from your team.' },
  ],
  discord: [
    { title: 'Announcement', description: 'A post about your product in my server’s announcements channel, with your link.' },
    { title: 'Sponsored channel', description: 'A channel in my server for your product, for a month.' },
    { title: 'Community event', description: 'A live event or Q&A in my server with someone from your team.' },
  ],
  instagram: [
    { title: 'Feed post', description: 'A photo or carousel post featuring your product, with your account tagged.' },
    { title: 'Reel', description: 'A short vertical video featuring your product.' },
    { title: 'Story set', description: 'Three Stories featuring your product, with a link sticker to your site.' },
    { title: 'Link in bio', description: 'Your link in my bio for a week.' },
  ],
  tiktok: [
    { title: 'Sponsored video', description: 'A TikTok featuring your product, in my usual style.' },
    { title: 'Product review', description: 'An honest, hands-on review of your product.' },
    { title: 'Video series', description: 'Three videos over a few weeks, each building on the last.' },
  ],
  podcast: [
    { title: 'Pre-roll read', description: 'A 15–30 second ad I read at the start of an episode.' },
    { title: 'Mid-roll read', description: 'A 60-second ad I read in the middle of an episode.' },
    { title: 'Dedicated episode', description: 'A whole episode about your product, or with someone from your team.' },
  ],
  twitch: [
    { title: 'Stream mention', description: 'A shoutout and your link in chat during a live stream.' },
    { title: 'Sponsored segment', description: 'A 10–15 minute segment using or playing your product live.' },
    { title: 'Dedicated stream', description: 'A whole stream built around your product.' },
  ],
  website: [
    { title: 'Sponsored article', description: 'An article about your product on my site, marked as sponsored.' },
    { title: 'Product review', description: 'An in-depth review of your product.' },
    { title: 'Link insertion', description: 'A sponsored link to your site in a relevant article I’ve already published.' },
  ],
  any: [
    { title: 'Bundle', description: 'Several channels together, for example a video plus a newsletter mention.' },
    { title: 'UGC video', description: 'A video made for your own channels and ads. You get the footage to use.' },
  ],
};

export function templatesFor(platform: string | null): PackageTemplate[] {
  return PACKAGE_TEMPLATES[platform ?? 'any'] ?? [];
}

/** What a platform calls its audience. */
const AUDIENCE_NOUNS: Record<string, string> = {
  youtube: 'subscribers',
  substack: 'subscribers',
  newsletter: 'subscribers',
  snapchat: 'subscribers',
  podcast: 'listeners',
  website: 'readers',
  reddit: 'members',
  discord: 'members',
};

export function audienceNoun(platform: string): string {
  return AUDIENCE_NOUNS[platform] ?? 'followers';
}

/** 48,200 → "48.2K"; 1,250,000 → "1.3M". */
export function formatCompact(n: number): string {
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(n);
}

/** One block of the storefront: a channel and the packages that run on it. */
export interface ChannelGroup<P extends StorefrontPackage = StorefrontPackage> {
  key: string;
  /** null for packages that work on any platform. */
  platform: string | null;
  /** The creator's row for this platform; null when there isn't one. */
  channel: StorefrontChannel | null;
  packages: P[];
}

/**
 * Packages grouped under the channel they run on, keeping the packages'
 * order. Channels with packages come first, then channels with none (so
 * they still show), then packages for a platform the creator hasn't added,
 * then "any platform" packages.
 */
export function groupByChannel<P extends StorefrontPackage>(packages: P[], channels: StorefrontChannel[]): ChannelGroup<P>[] {
  const byPlatform = new Map<string, ChannelGroup<P>>();
  const withPackages: ChannelGroup<P>[] = [];
  const any: ChannelGroup<P> = { key: 'any', platform: null, channel: null, packages: [] };
  for (const c of channels) byPlatform.set(c.platform, { key: c.platform, platform: c.platform, channel: c, packages: [] });
  for (const p of packages) {
    if (!p.platform) {
      any.packages.push(p);
      continue;
    }
    let group = byPlatform.get(p.platform);
    if (!group) {
      group = { key: p.platform, platform: p.platform, channel: null, packages: [] };
      byPlatform.set(p.platform, group);
    }
    if (group.packages.length === 0) withPackages.push(group);
    group.packages.push(p);
  }
  const channelsFirst = withPackages.filter((g) => g.channel);
  const orphans = withPackages.filter((g) => !g.channel);
  const empty = channels.map((c) => byPlatform.get(c.platform)!).filter((g) => g.packages.length === 0);
  return [...channelsFirst, ...empty, ...orphans, ...(any.packages.length ? [any] : [])];
}
