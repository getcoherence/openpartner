import { useQuery } from '@tanstack/react-query';
import { api, currentTenantSlug } from '../api.js';

/**
 * Shape of `GET /config/program`. Mirrors the API's `ProgramSettings`
 * (apps/api/src/routes/settings.ts). `whiteLabel` is the EFFECTIVE
 * entitlement (provisioned flag AND an entitling billing state),
 * computed server-side.
 */
export interface ProgramSettings {
  programName: string | null;
  supportEmail: string | null;
  logoUrl: string | null;
  brandColor: string | null;
  programTermsUrl: string | null;
  whiteLabel: boolean;
}

/** Platform fallback applied whenever the tenant hasn't set a brand name. */
export const DEFAULT_BRAND = 'OpenPartner';

export interface Brand {
  /** Brand name with the platform fallback applied — never empty. When
   *  not white-label this resolves to 'OpenPartner', so existing
   *  non-white-label rendering is unchanged. */
  programName: string;
  logoUrl: string | null;
  supportEmail: string | null;
  /** Effective white-label entitlement. When true: hide every Network /
   *  Discover / "Powered by" surface and never render the 'OpenPartner'
   *  product name in partner-facing UI; brand name + logo come from
   *  programName / logoUrl. */
  whiteLabel: boolean;
  isLoading: boolean;
}

/**
 * Single shared accessor for the per-tenant brand / program settings.
 *
 * Every component that needs the brand name or the white-label flag reads
 * it through here. It wraps the cached `['program-settings']` query, so
 * the Sidebar, the route guards, and any page all resolve from one fetch
 * rather than each issuing its own `/config/program` call.
 *
 * Tenant-scoped only: this hits the authenticated `/config/program`
 * endpoint via `api()` (which carries the `/t/<slug>` prefix in
 * multi-tenant mode). The cross-tenant Network UI (creator portal,
 * landing, workspace picker) is never white-labeled and does not use it.
 */
export function useBrand(): Brand {
  const { data, isLoading } = useQuery({
    queryKey: ['program-settings'],
    queryFn: () => api<ProgramSettings>('/config/program'),
    // Refetch infrequently — admin rarely changes this.
    staleTime: 60_000,
  });
  return {
    programName: data?.programName || DEFAULT_BRAND,
    logoUrl: data?.logoUrl ?? null,
    supportEmail: data?.supportEmail || null,
    whiteLabel: data?.whiteLabel ?? false,
    isLoading,
  };
}

/** Shape of the public `GET /branding` bootstrap (no auth). */
export interface PublicBranding {
  /** Slug of the tenant resolved for the request — on a prefix-less call
   *  it's non-null only when the HOST resolved it (custom domain), or
   *  'default' on single-tenant installs. */
  tenantSlug: string | null;
  programName: string | null;
  logoUrl: string | null;
  faviconUrl: string | null;
  brandColor: string | null;
  supportEmail: string | null;
  programTermsUrl: string | null;
  whiteLabel: boolean;
}

/**
 * PRE-AUTH brand accessor for login / magic-link landing pages. Hits the
 * public `/branding` endpoint, which resolves the tenant by custom-domain
 * host or the /t/<slug>/ URL prefix — so a white-label tenant's sign-in
 * page carries its brand before any session exists. On platform-level
 * pages (no tenant in the URL / platform host) the API returns nulls and
 * this falls back to the OpenPartner default.
 */
export function usePublicBrand(): Brand & {
  brandColor: string | null;
  faviconUrl: string | null;
  tenantSlug: string | null;
} {
  // api() scopes by the /t/<slug>/ URL prefix at call time — key the cache
  // by it too, or an SPA navigation from a platform page (nulls) into a
  // tenant page would keep serving the platform's empty branding.
  const { data, isLoading } = useQuery({
    queryKey: ['public-branding', currentTenantSlug()],
    queryFn: () => api<PublicBranding>('/branding'),
    staleTime: 60_000,
  });
  return {
    programName: data?.programName || DEFAULT_BRAND,
    logoUrl: data?.logoUrl ?? null,
    faviconUrl: data?.faviconUrl ?? null,
    supportEmail: data?.supportEmail || null,
    whiteLabel: data?.whiteLabel ?? false,
    brandColor: data?.brandColor ?? null,
    tenantSlug: data?.tenantSlug ?? null,
    isLoading,
  };
}
