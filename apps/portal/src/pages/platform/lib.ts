/**
 * Platform-ops console API layer.
 *
 * The operations console is PLATFORM-LEVEL, not tenant-scoped — it manages
 * every brand from OpenPartner's own operator seat. So it must NOT go
 * through the tenant `api()` helper (which auto-prepends `/t/<slug>`).
 * Everything here talks to raw `/api/...` with the operator's httpOnly
 * cookie via `credentials: 'include'`, mirroring Signin.tsx.
 */

export interface PlatformOperator {
  email: string;
  role: 'admin' | 'support';
}

export type ApprovalStatus = 'pending' | 'approved' | 'rejected';
export type BrandStatus = 'active' | 'suspended' | 'cancelled';

export interface PlatformBrand {
  id: string;
  slug: string;
  displayName: string;
  approvalStatus: ApprovalStatus;
  status: BrandStatus;
  approvalReason: string | null;
  reviewedAt: string | null;
  reviewedByEmail: string | null;
  billingPlan: string | null;
  createdAt: string;
  createdBy: string | null;
  adminEmail: string | null;
  adminName: string | null;
  programCount: number;
  blockedProgramCount: number;
}

export interface PlatformProgram {
  id: string;
  name: string;
  /** Where the program's partner links land — the phishing/spam tell. */
  destinationUrl: string;
  deepLinkAllowedDomains: string | null;
  marketplaceDescription: string | null;
  categories: string[];
  shareOnNetwork: boolean;
  endsAt: string | null;
  blockedAt: string | null;
  blockedReason: string | null;
  blockedByEmail: string | null;
  createdAt: string;
  linkCount: number;
}

/** A Network creator (partner). Network-owned — one identity across every
 *  brand — so blocking is a network-level act, not per-tenant. */
export interface NetworkCreator {
  id: string;
  email: string;
  name: string;
  handle: string | null;
  status: 'active' | 'suspended' | 'blocked';
  avatarUrl: string | null;
  bio: string | null;
  categories: string[];
  blockedAt: string | null;
  blockedReason: string | null;
  blockedByEmail: string | null;
  lastSignInAt: string | null;
  createdAt: string;
  affiliationCount: number;
  platformCount: number;
  /** False = below the discovery bar, so they're hidden from the marketplace
   *  until they fill their profile in. */
  profileComplete: boolean;
  profileMissing: Array<{ field: string; label: string }>;
}

export interface BlocklistEntry {
  id: string;
  type: 'email' | 'domain';
  value: string;
  reason: string | null;
  createdByEmail: string | null;
  createdAt: string;
}

export interface AuditEvent {
  id: string;
  platformAdminEmail: string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  detail: unknown;
  createdAt: string;
}

export class PlatformApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = 'PlatformApiError';
  }
}

/**
 * Raw fetch to a platform-level `/api` route. Throws {@link PlatformApiError}
 * on any non-2xx, pulling `{ error }` out of the body when present (the
 * server convention — e.g. `read_only_operator`, `not_an_operator`).
 */
export async function papi<T = unknown>(
  path: string,
  init: Omit<RequestInit, 'body'> & { body?: unknown } = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  const res = await fetch(`/api${path}`, {
    ...init,
    headers,
    credentials: 'include',
    body:
      init.body === undefined
        ? undefined
        : typeof init.body === 'string'
          ? init.body
          : JSON.stringify(init.body),
  });
  if (!res.ok) {
    let message = `${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body && typeof body.error === 'string' && body.error.length > 0) message = body.error;
    } catch {
      /* non-JSON body — keep the status code */
    }
    throw new PlatformApiError(res.status, message);
  }
  return (await res.json()) as T;
}

/** Turn a server error code into an operator-friendly sentence. */
export function friendlyPlatformError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  switch (raw) {
    case 'read_only_operator':
      return 'Your operator account is read-only — ask an admin to make this change.';
    case 'not_an_operator':
      return 'This account isn’t an OpenPartner operator.';
    default:
      return raw;
  }
}
