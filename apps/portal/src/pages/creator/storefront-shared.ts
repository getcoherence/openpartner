/**
 * Shared bits of the creator storefront (the Network's
 * docs/creator-storefront.md): the package shape and how a price reads.
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
};

/** Currencies offered in the package editor. The Network accepts any ISO
 *  4217 code; this list just keeps the picker short. */
export const PACKAGE_CURRENCIES = ['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'INR', 'JPY', 'BRL', 'MXN', 'SGD'] as const;

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
