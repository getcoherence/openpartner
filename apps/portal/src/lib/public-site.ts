/**
 * The public marketing site, where creator storefronts live for visitors
 * without an account: openpartner.dev/creators/<handle> (its full
 * storefront and a request form anyone can send). The app's own
 * /creators/<handle> forwards there; brands on OpenPartner book from
 * Network → Discover creators instead.
 *
 * VITE_PUBLIC_SITE_URL points a local or staging portal at its own copy.
 */
export const PUBLIC_SITE_URL = ((import.meta.env.VITE_PUBLIC_SITE_URL as string | undefined) ?? 'https://openpartner.dev').replace(/\/$/, '');

export const publicStorefrontUrl = (handle: string) => `${PUBLIC_SITE_URL}/creators/${encodeURIComponent(handle)}`;

/** The marketing site's storefront listing. */
export const MARKETPLACE_CREATORS_URL = `${PUBLIC_SITE_URL}/marketplace/creators`;
