/**
 * The application a creator fills in on a brand's public join page
 * (POST /partner-signup `application`), plus the audience-size buckets it
 * shares with the creator's Network profile.
 *
 * Shared by the API (which validates and stores it on
 * Partner.metadata.application) and the portal (which mirrors the same
 * rules client-side and renders the answers for admins).
 *
 * AUDIENCE_SIZES mirrors the Network's Creator.audienceSize enum: the
 * brand sends it in /partners/upsert `creatorProfile` and reads it back
 * from GET /creators/me. Keep the two lists identical.
 */

export const AUDIENCE_SIZES = ['under_1k', '1k_10k', '10k_50k', '50k_250k', '250k_1m', 'over_1m'] as const;

export type AudienceSize = (typeof AUDIENCE_SIZES)[number];

export const AUDIENCE_SIZE_LABELS: Readonly<Record<AudienceSize, string>> = {
  under_1k: 'Under 1K',
  '1k_10k': '1K–10K',
  '10k_50k': '10K–50K',
  '50k_250k': '50K–250K',
  '250k_1m': '250K–1M',
  over_1m: 'Over 1M',
};

export function isAudienceSize(value: unknown): value is AudienceSize {
  return typeof value === 'string' && (AUDIENCE_SIZES as readonly string[]).includes(value);
}

/** Human label for a bucket. An unknown value renders verbatim rather than
 *  vanishing; null/undefined/empty → null. */
export function audienceSizeLabel(value: string | null | undefined): string | null {
  if (!value) return null;
  return isAudienceSize(value) ? AUDIENCE_SIZE_LABELS[value] : value;
}

export const PARTNER_APPLICATION_LIMITS = {
  urlMax: 500,
  socialMin: 1,
  socialMax: 5,
  pitchMin: 40,
  pitchMax: 1000,
} as const;

/** An absolute http(s) URL with a host, at most urlMax characters. Callers
 *  trim first. */
export function isHttpUrl(value: string): boolean {
  if (!value || value.length > PARTNER_APPLICATION_LIMITS.urlMax) return false;
  try {
    const u = new URL(value);
    return (u.protocol === 'http:' || u.protocol === 'https:') && u.hostname.length > 0;
  } catch {
    return false;
  }
}

/** Stored on Partner.metadata.application, a server-owned key: the public
 *  signup can't forge it through `profile`. Travels with the Partner row on
 *  export/import. */
export interface PartnerApplication {
  websiteUrl: string;
  socialUrls: string[];
  audienceSize: AudienceSize;
  pitch: string;
  submittedAt: string;
}
