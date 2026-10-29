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
  /** Where the brand says it is based (ISO code); null = not asked yet. */
  country: string | null;
  /** IP country when it declared, for spotting a mismatch. */
  ipCountryAtDeclaration: string | null;
  /** Latest Consolidated Screening List answer per screened name (brand
   *  name, admin name), newest first. Empty = never screened. */
  screenings: PlatformScreening[];
}

export type ScreeningResult = 'clear' | 'possible_match' | 'error' | 'skipped';
export type ScreeningDecision = 'cleared' | 'confirmed_match';

/** A list entry a screened name came close to. */
export interface ScreeningMatch {
  source: string;
  name: string;
  /** Fuzzy score 0-100 (100 = exact); null when the list gave none. */
  score: number | null;
  entryId: string | null;
  type: string | null;
  programs: string[];
  countries: string[];
}

/** One sanctions screening of a brand or partner name. */
export interface PlatformScreening {
  id: string;
  subjectKind: 'tenant' | 'partner';
  subjectId: string;
  tenantId: string;
  screenedName: string;
  country: string | null;
  result: ScreeningResult;
  matches: ScreeningMatch[];
  errorDetail: string | null;
  trigger: string;
  screenedAt: string;
  decision: ScreeningDecision | null;
  reviewedByEmail: string | null;
  reviewedAt: string | null;
  reviewNote: string | null;
  /** The decision was inherited from an earlier review of the same list
   *  entries (a rescreen found nothing new). */
  decisionCarried: boolean;
}

export type PayoutHoldReason = 'country_not_supported' | 'screening_confirmed' | 'screening_review' | 'screening_pending';

/** GET /platform-admin/screening. */
export interface ScreeningOverview {
  cslConfigured: boolean;
  matchScoreThreshold: number;
  reviews: Array<
    PlatformScreening & {
      brandName: string | null;
      brandSlug: string | null;
      partnerName: string | null;
      partnerEmail: string | null;
    }
  >;
  held: Array<{
    tenantId: string;
    brandName: string | null;
    brandSlug: string | null;
    partnerId: string;
    partnerName: string;
    partnerEmail: string;
    reason: PayoutHoldReason;
    country: string | null;
    /** 'held' = Stripe payouts not made; 'warning' = the brand pays them itself. */
    effect: 'held' | 'warning';
    owed: Array<{ currency: string; amount: number }>;
  }>;
}

export interface PlatformProgram {
  id: string;
  name: string;
  /** Where the program's partner links land — the phishing/spam tell. */
  destinationUrl: string;
  deepLinkAllowedDomains: string | null;
  marketplaceDescription: string | null;
  marketplaceCoverUrl: string | null;
  marketplaceVideoUrl: string | null;
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
  /** Storefront imports refused because another account holds the page.
   *  Absent on an older Network. */
  importConflicts?: Array<{
    source: string;
    sourceKey: string;
    /** The claim to release; null once it's gone. */
    claimId: string | null;
    /** 'refused': this creator tried; 'claimant': this creator holds the page. */
    role: 'refused' | 'claimant';
    otherCreatorId: string | null;
    otherEmail: string | null;
    attempts: number;
    lastAttemptAt: string;
  }>;
  // ---- Review (absent on a Network that predates creator review) ----
  /** Brands and the public see the creator only once 'approved' (and
   *  complete). */
  reviewStatus?: ApprovalStatus;
  reviewedAt?: string | null;
  /** Internal note on the last decision. */
  reviewReason?: string | null;
  reviewedByEmail?: string | null;
  /** When the creator last edited their profile. */
  profileUpdatedAt?: string;
  platforms?: Array<{
    platform: string;
    handle: string;
    profileUrl: string | null;
    followerCount: number | null;
    verified: boolean;
  }>;
  messageCount?: number;
  unreadMessageCount?: number;
  lastMessageAt?: string | null;
}

/** An operator's message to a creator (shown in their portal). */
export interface NetworkCreatorMessage {
  id: string;
  body: string;
  sentByEmail: string | null;
  createdAt: string;
  /** Null when it wasn't emailed. */
  emailedAt: string | null;
  /** When the creator marked it read. */
  readAt: string | null;
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

/** A vendor in the Network review queue. `managedBy` is set for our own
 *  hosted brands — their review follows brand approval (Brands tab). */
export interface NetworkVendorReview {
  id: string;
  displayName: string;
  logoUrl: string | null;
  instanceUrl: string;
  tier: 'hosted' | 'self_hosted';
  /** Credential liveness: 'pending' = onboarding email not verified yet. */
  status: string;
  contactEmail: string;
  contactName: string | null;
  partnerCount: number;
  lastHeartbeatAt: string | null;
  suspensionReason: string | null;
  reviewStatus: ApprovalStatus;
  reviewedAt: string | null;
  reviewReason: string | null;
  createdAt: string;
  offeringCount: number;
  publishedOfferingCount: number;
  /** Text only — never render productUrl as a live link. */
  offerings: Array<{
    id: string;
    title: string;
    description: string | null;
    productUrl: string;
    published: boolean;
    createdAt: string;
  }>;
  managedBy: { tenantId: string; slug: string; displayName: string } | null;
}

export interface NotificationSettings {
  brandSetupReminders: boolean;
  creatorProfileReminders: boolean;
  creatorStorefrontNudge: boolean;
}

export interface NotificationsState {
  settings: NotificationSettings;
  brandRemindersSentLast7Days: number;
  networkConfigured: boolean;
}

/** OpenPartner's own partner program (house-program.ts on the API). */
export interface HouseProgramState {
  settings: { tenantId: string | null };
  tenant: { id: string; slug: string; displayName: string; status: string; approvalStatus: string } | null;
  stripeConnection: { stripeAccountId: string; livemode: boolean; connectedAt: string; lastEventAt: string | null } | null;
  referredBrands: number;
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

/** Who the storefront nudge would email (dryRun) or did email. */
export interface StorefrontNudgeRunResult {
  dryRun: boolean;
  eligible: Array<{
    creatorId: string;
    email: string;
    name: string;
    handle: string | null;
    /** Their biggest channel, when it has 1,000 or more followers. */
    audience: { platform: string; count: number } | null;
    /** Packages saved, drafts included, and how many are published. */
    packages: number;
    publishedPackages: number;
    bookingsOpen: boolean;
    paymentsReady: boolean;
  }>;
  sent: number;
  failed: number;
}

/** Platform fee — the commission-floor rule (docs/platform-fee.md). */
export interface FeeRates {
  revenueRate: number;
  commissionRate: number;
}

export interface FeeRuleSettings {
  shadow: boolean;
  cutoverAt: string | null;
  rates: { flat: FeeRates; revshare: FeeRates };
}

export interface FeeTenantStatus {
  tenantId: string;
  slug: string;
  displayName: string;
  plan: string | null;
  mode: string;
  subscribed: boolean;
  rule: 'new' | 'scheduled' | 'old';
  effectiveAt: string | null;
  effectiveSource: 'new_plan' | 'notice' | 'contract' | null;
  planStartedAt: string | null;
  noticeSentAt: string | null;
  noticeRecipients: string[] | null;
  revenueRate: number;
  commissionRate: number;
  contract: boolean;
  monthlyMinimumUsd: number | null;
  contractNote: string | null;
  shadow: {
    reports: number;
    conversions: number;
    oldFeeUsd: number;
    newFeeUsd: number;
    floorConversions: number;
    renamedSaleConversions: number;
  } | null;
}

export interface FeesState {
  settings: FeeRuleSettings;
  meterRates: { flat: number; revshare: number };
  noticeDays: number;
  tenants: FeeTenantStatus[];
}

export interface FeeComparison {
  conversions: number;
  oldBasisUsd: number;
  newBasisUsd: number;
  oldFeeUsd: number;
  newFeeUsd: number;
  floorConversions: number;
  renamedSaleConversions: number;
  heldOut: Record<string, number> | null;
}

export interface FeeEstimate extends FeeComparison {
  tenantId: string;
  slug: string;
  mode: string;
  revenueRate: number;
  commissionRate: number;
}

export interface NoticeCandidate {
  tenantId: string;
  slug: string;
  brandName: string;
  plan: string | null;
  recipients: Array<{ email: string; name: string | null }>;
  revenueRate: number;
  commissionRate: number;
  effectiveAt: string | null;
  error?: string;
}

export interface NoticeRun {
  dryRun: boolean;
  cutoverAt?: string | null;
  candidates?: NoticeCandidate[];
  sample?: { to: string; subject: string; text: string } | null;
  sent?: Array<{ tenantId: string; slug: string; recipients: string[]; effectiveAt: string; failedRecipients: string[] }>;
  skipped?: Array<{ tenantId: string; slug: string; reason: string }>;
  failed?: Array<{ tenantId: string; slug: string; reason: string }>;
}

export interface ContractStatement {
  month: string;
  revenueRate: number;
  commissionRate: number;
  monthlyMinimumUsd: number | null;
  conversions: number;
  revenueByCurrency: Record<string, number>;
  commissionsByCurrency: Record<string, number>;
  feeUsd: number;
  minimumTopUpUsd: number;
  amountOwedUsd: number;
  heldOut: Record<string, number> | null;
}

export interface FeeReviewSignals {
  windowDays: number;
  noCommissionActivity: Array<{ tenantId: string; slug: string; clicks: number; identities: number }>;
  commissionAboveValue: Array<{ tenantId: string; slug: string; events: number; sampleEventIds: string[] }>;
  lowConversion: {
    peerMedian: number | null;
    peers: number;
    tenants: Array<{ tenantId: string; slug: string; clicks: number; conversions: number; rate: number }>;
  };
}

export type CollectionMethod = 'send_invoice' | 'charge_automatically';

export interface InvoiceBillingTenant {
  tenantId: string;
  slug: string;
  name: string;
  plan: string | null;
  country: string | null;
  profile: {
    collectionMethod: CollectionMethod | null;
    daysUntilDue: number;
    graceDays: number;
    gstin: string | null;
    updatedByEmail: string | null;
    gstinUpdatedByEmail: string | null;
    updatedAt: string;
  } | null;
  terms: {
    method: CollectionMethod;
    source: 'ops' | 'country' | 'default';
    daysUntilDue: number;
    graceDays: number;
    country: string | null;
    gstin: string | null;
    gstinRequired: boolean;
  };
  subscription: {
    live: boolean;
    status: string | null;
    collectionMethod: CollectionMethod | null;
  };
  /** The oldest unpaid pay-by-invoice invoice past its due date. */
  overdue: { invoiceId: string | null; since: string; graceEndsAt: string; graceExpired: boolean; neverPaid: boolean } | null;
}

export interface InvoiceBillingState {
  settings: { defaultCountries: string[] };
  defaults: { daysUntilDue: number; graceDays: number };
  tenants: InvoiceBillingTenant[];
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
    case 'creator_not_active':
      return 'That creator is blocked or deleting their account, so they can’t read a message.';
    case 'managed_by_brand_review':
      return 'That vendor is one of our hosted brands — approve or reject it on the Brands tab.';
    case 'network_not_configured':
      return 'NETWORK_URL / NETWORK_ADMIN_API_KEY aren’t set, so creator reminders can’t reach the Network.';
    case 'cutover_in_past':
      return 'The cutover can’t be more than a day in the past: it would reprice plans bought under the old pricing.';
    case 'no_cutover':
      return 'Set the cutover before sending pricing notices.';
    case 'minimum_requires_enterprise':
      return 'A monthly minimum is invoiced from the contract statement, so move the brand to the Enterprise plan first.';
    case 'fx_rates_unavailable':
      return 'The ECB rate feed is unreachable, so non-USD amounts can’t be converted right now. Try again later.';
    case 'note_required':
      return 'Say why the match isn’t them before clearing it: the note is the compliance record.';
    case 'already_reviewed':
      return 'Someone has already reviewed this match. Refresh to see the decision.';
    case 'superseded':
      return 'A newer screening has replaced this one. Refresh and review the latest.';
    case 'screening_not_configured':
      return 'CSL_API_KEY isn’t set, so nothing can be screened.';
    case 'gstin_required':
      return 'This brand is in India and has no GSTIN on file. Ask it to add one on its Billing page first.';
    case 'no_payment_method':
      return 'The brand has no card on file. It can add one in the Stripe Customer Portal from its Billing page.';
    case 'not_found':
      return 'No brand with that id or slug.';
    case 'tenant_not_found':
      return 'No brand has that slug.';
    default:
      return raw;
  }
}
