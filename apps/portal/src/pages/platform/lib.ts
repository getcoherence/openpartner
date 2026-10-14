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
  /** Local setup checklist (program / listing / tracking / partners). */
  setupComplete: boolean;
  setupMissing: string[];
  setupRemindersSent: number;
  lastSetupReminderAt: string | null;
  /** Latest marketplace policy warning sent to this brand, if any. */
  lastPolicyWarningAt: string | null;
  policyWarningDeadline: string | null;
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
  /** Profile reminders sent so far (absent on an older Network). */
  remindersSent?: number;
  lastRemindedAt?: string | null;
  /** Set when the creator unsubscribed from reminder emails. */
  emailOptOutAt?: string | null;
}

/** A Network vendor (brand) as the marketplace sees it. Featured fields are
 *  absent when the Network predates featured placement. */
export interface NetworkVendor {
  id: string;
  displayName?: string;
  logoUrl?: string | null;
  status: string;
  reviewStatus?: ApprovalStatus;
  partnerCount?: number;
  /** Null = not featured; lower ranks list first. */
  featuredRank?: number | null;
  /** ISO end of the placement; null = no end date. */
  featuredUntil?: string | null;
  publishedOfferingCount?: number;
}

export interface FeaturedEntry {
  id: string;
  until: string | null;
}

export interface NotificationSettings {
  brandSetupReminders: boolean;
  creatorProfileReminders: boolean;
}

export interface NotificationsState {
  settings: NotificationSettings;
  brandRemindersSentLast7Days: number;
  networkConfigured: boolean;
}

/** Who a reminder run would email (dryRun) or did email. Brand rows carry a
 *  slug, creator rows a name. */
export interface ReminderRunResult {
  dryRun: boolean;
  eligible: Array<{
    tenantId?: string;
    slug?: string;
    creatorId?: string;
    name?: string;
    email: string;
    step: number;
    missing: string[];
  }>;
  sent: number;
  failed: number;
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
    case 'setup_complete':
      return 'That brand has finished setup — nothing to remind them about.';
    case 'profile_complete':
      return 'That creator’s profile is already complete.';
    case 'opted_out':
      return 'They unsubscribed from reminder emails.';
    case 'max_reminders_sent':
      return 'They’ve already had all three reminders.';
    case 'no_signed_in_admin':
      return 'No admin on this brand has signed in yet, so their email isn’t confirmed.';
    case 'email_unverified':
      return 'This creator never confirmed their email, so we don’t send them reminders.';
    case 'not_eligible':
      return 'Not eligible for reminders (blocked, suspended, rejected, or being deleted).';
    case 'no_admin':
      return 'This brand has no admin to email.';
    case 'mail_failed':
      return 'The email couldn’t be sent — check the platform mail settings and try again.';
    case 'vendor_not_found':
      return 'That brand is no longer on the Network — refresh and try again.';
    case 'network_not_configured':
      return 'NETWORK_URL / NETWORK_ADMIN_API_KEY aren’t set, so creator reminders can’t reach the Network.';
    default:
      return raw;
  }
}
