/**
 * Minimal email templates for partner invite + signin. Plain-text body
 * is always authoritative — the HTML body is a simple wrapper so it
 * renders cleanly in Gmail / Outlook without requiring MJML or a
 * templating engine.
 */

import { getPortalBaseUrl, type PortalLinkTenant } from './portal-url.js';

/**
 * The ONE place magic-link URLs are built (spec §4.4). Tenant-aware: a
 * white-label tenant's links land on its custom domain (where the host-only
 * session cookie will be set); path-based tenants get /t/<slug>/ links; the
 * platform/single-host case gets a bare PORTAL_URL link. Note that a
 * freshly-signed-up white-label tenant has no customDomain yet — its first
 * admin invite is necessarily path-based until the domain verifies.
 */
export function buildMagicLinkUrl(token: string, tenant?: PortalLinkTenant | null): string {
  return `${getPortalBaseUrl(tenant)}/auth/magic?token=${encodeURIComponent(token)}`;
}

export interface EmailTemplate {
  subject: string;
  text: string;
  html: string;
}

export function partnerInviteEmail(name: string, link: string, brandName: string | null = null): EmailTemplate {
  const brand = brandName || 'the partner program';
  const subject = brandName ? `You're invited to ${brandName}'s partner program` : `You're invited to the partner program`;
  const text = [
    `Hi ${name},`,
    ``,
    `You've been invited to join ${brand}. Click the link below to accept`,
    `and set up your dashboard:`,
    ``,
    link,
    ``,
    `This link is good for 15 minutes.`,
  ].join('\n');
  return { subject, text, html: wrap(text, link, 'Accept invite') };
}

/** Public signup on a program that holds applications for review. No
 *  link: the sign-in link comes with the approval (POST
 *  /partners/:id/invite), so nothing here can activate the account. */
export function partnerApplicationReceivedEmail(name: string, brandName: string | null = null): EmailTemplate {
  const brand = brandName || 'the partner program';
  const subject = brandName ? `We received your application to ${brandName}` : `We received your partner application`;
  const text = [
    `Hi ${name},`,
    ``,
    `Thanks for applying to ${brand}. The team reviews each application by hand.`,
    `Once you're approved, we'll email you a link to sign in and set up your dashboard.`,
  ].join('\n');
  return { subject, text, html: plainHtml(text) };
}

/** The join-page answers shown in {@link partnerApplicationAdminEmail}. */
export interface PartnerApplicationSummary {
  websiteUrl: string;
  socialUrls: string[];
  /** Human label, e.g. "10K–50K". */
  audienceSize: string;
  pitch: string;
}

/** Brand admin: someone applied through the public join page and is
 *  waiting for review. */
export function partnerApplicationAdminEmail(
  applicantName: string,
  applicantEmail: string,
  brandName: string | null,
  reviewUrl: string,
  application?: PartnerApplicationSummary,
): EmailTemplate {
  const subject = `New partner application: ${applicantName}`;
  // Every applicant-supplied line carries a prefix: wrap() turns any line
  // that STARTS with "http" into the review-button link, so a bare URL from
  // the applicant must never begin a line.
  const answers = application
    ? [
        `Website or main channel: ${application.websiteUrl}`,
        `Social profiles:`,
        ...application.socialUrls.map((u) => `  - ${u}`),
        `Audience size: ${application.audienceSize}`,
        `How they'd promote you:`,
        ...application.pitch.split(/\r?\n/).map((l) => `> ${l}`),
        ``,
      ]
    : [];
  const text = [
    `Hi${brandName ? ` from ${brandName}` : ''},`,
    ``,
    `${applicantName} (${applicantEmail}) applied to your partner program and is waiting for review.`,
    ``,
    ...answers,
    `They can't sign in until you approve them. Approve or decline on the Partners page:`,
    ``,
    reviewUrl,
  ].join('\n');
  return { subject, text, html: wrap(text, reviewUrl, 'Review application') };
}

export function partnerSigninEmail(name: string, link: string, brandName: string | null = null): EmailTemplate {
  const subject = brandName ? `Sign in to ${brandName}` : `Your partner dashboard sign-in link`;
  const text = [
    `Hi ${name},`,
    ``,
    brandName
      ? `Click the link below to sign in to ${brandName}:`
      : `Click the link below to sign in to your partner dashboard:`,
    ``,
    link,
    ``,
    `This link is good for 15 minutes. If you didn't ask for it, ignore this email.`,
  ].join('\n');
  return { subject, text, html: wrap(text, link, 'Sign in') };
}

export function adminInviteEmail(name: string, link: string, programName: string | null): EmailTemplate {
  const brand = programName || 'your partner program';
  const subject = `You've been invited to administer ${brand}`;
  const text = [
    `Hi ${name},`,
    ``,
    `You've been invited as an administrator for ${brand}. Click the link below`,
    `to accept the invitation and sign in:`,
    ``,
    link,
    ``,
    `This link is good for 15 minutes.`,
  ].join('\n');
  return { subject, text, html: wrap(text, link, 'Accept invite') };
}

export function adminSigninEmail(name: string, link: string): EmailTemplate {
  const subject = `Your admin dashboard sign-in link`;
  const text = [
    `Hi ${name},`,
    ``,
    `Click the link below to sign in:`,
    ``,
    link,
    ``,
    `This link is good for 15 minutes. If you didn't ask for it, ignore this email.`,
  ].join('\n');
  return { subject, text, html: wrap(text, link, 'Sign in') };
}

/** "Forgot password" mail. `brandName` names the portal for a partner
 *  reset; a brand admin's or operator's reset is the OpenPartner account
 *  and leaves it null. Also how someone who has only ever used emailed
 *  links sets a first password. */
export function passwordResetEmail(link: string, brandName: string | null = null): EmailTemplate {
  const where = brandName ? `${brandName}` : 'OpenPartner';
  const subject = `Set your ${where} password`;
  const text = [
    `Hi,`,
    ``,
    `Someone asked to set a new password for this address on ${where}. Click the link below to choose one:`,
    ``,
    link,
    ``,
    `This link is good for 15 minutes. If you didn't ask for it, ignore this email — your password hasn't changed.`,
  ].join('\n');
  return { subject, text, html: wrap(text, link, 'Choose a password') };
}

export function partnerRevokedEmail(name: string, reason: string | null): EmailTemplate {
  const subject = `Your partner account has been suspended`;
  const text = [
    `Hi ${name},`,
    ``,
    `Your partner account has been suspended by the program administrator.`,
    ...(reason ? [``, `Reason: ${reason}`] : []),
    ``,
    `If you believe this was done in error, please contact the administrator of the partner program directly.`,
  ].join('\n');
  const html = plainHtml(text);
  return { subject, text, html };
}

/**
 * Partner: their payout details were changed or removed. Sent on every
 * change, whoever made it, because a quietly redirected payout is the
 * classic account-takeover fraud. Carries only the masked summary
 * (payout-profile.ts summarizeDetails), never the details.
 */
export function payoutDetailsChangedEmail(opts: {
  name: string;
  brandName: string | null;
  /** The new destination, masked; null when the details were removed. */
  summary: string | null;
  changedBy: 'partner' | 'admin' | 'api';
}): EmailTemplate {
  const brand = opts.brandName || 'the partner program';
  const subject = opts.summary ? `Your payout details for ${brand} were changed` : `Your payout details for ${brand} were removed`;
  const who = opts.changedBy === 'partner' ? 'from your partner account' : `by ${brand}`;
  const text = [
    `Hi ${opts.name},`,
    ``,
    opts.summary
      ? `Your payout details for ${brand} were changed ${who}. Payouts will now go to: ${opts.summary}.`
      : `Your payout details for ${brand} were removed ${who}.`,
    ``,
    `If you didn't make or expect this change, contact ${brand} right away, before your next payout is sent.`,
  ].join('\n');
  return { subject, text, html: plainHtml(text) };
}

/** Brand admin: 7-day notice that a Campaign is about to end. */
export function campaignEndingBrandEmail(
  brandName: string | null,
  campaignName: string,
  endsAt: Date,
  manageUrl: string,
): EmailTemplate {
  const dateStr = endsAt.toUTCString().replace(/ \d\d:\d\d:\d\d GMT$/, '');
  const subject = `"${campaignName}" ends in 7 days`;
  const text = [
    `Hi${brandName ? ` from ${brandName}` : ''},`,
    ``,
    `Your campaign "${campaignName}" is scheduled to end ${dateStr}.`,
    ``,
    `Existing share-links will keep redirecting after that date — your`,
    `partners' posted content stays alive — but no new commissions will`,
    `accrue on conversions dated past the end.`,
    ``,
    `If you'd like to keep it running, edit the end date in your admin:`,
    ``,
    manageUrl,
  ].join('\n');
  return { subject, text, html: wrap(text, manageUrl, 'Manage campaign') };
}

/** Partner: 7-day notice that a Campaign they have at least one Link
 *  in is about to end. */
export function campaignEndingPartnerEmail(
  partnerName: string,
  brandName: string | null,
  campaignName: string,
  endsAt: Date,
  programUrl: string,
): EmailTemplate {
  const dateStr = endsAt.toUTCString().replace(/ \d\d:\d\d:\d\d GMT$/, '');
  const fromBrand = brandName ?? 'the brand';
  const subject = `Heads up — "${campaignName}" ends in 7 days`;
  const text = [
    `Hi ${partnerName},`,
    ``,
    `The "${campaignName}" program from ${fromBrand} ends ${dateStr}.`,
    ``,
    `Your existing share-links keep working past that date, but clicks`,
    `that come in afterward won't earn commission. Worth squeezing in any`,
    `last promotion before then.`,
    ``,
    programUrl,
  ].join('\n');
  return { subject, text, html: wrap(text, programUrl, 'View program') };
}

// ---------------------------------------------------------------------------
// Performance bounties (performance-bounties.ts) — partner-facing. `goal` is
// renderBountySummary's sentence, never free text; `description` is the
// brand's own words shown beside it.
// ---------------------------------------------------------------------------

/** Partner: a bounty they can earn has started. */
export function bountyStartedEmail(opts: {
  partnerName: string;
  brandName: string | null;
  bountyName: string;
  goal: string;
  description: string | null;
  url: string;
}): EmailTemplate {
  const fromBrand = opts.brandName ?? 'Your partner program';
  const subject = `New bounty from ${fromBrand}: ${opts.bountyName}`;
  const text = [
    `Hi ${opts.partnerName},`,
    ``,
    `${fromBrand} just launched a bounty, "${opts.bountyName}".`,
    ``,
    opts.goal,
    ...(opts.description ? [``, opts.description] : []),
    ``,
    `Track your progress in your partner dashboard.`,
    ``,
    opts.url,
  ].join('\n');
  return { subject, text, html: wrap(text, opts.url, 'See the bounty') };
}

/** Partner: 7-day notice that a bounty they haven't reached yet ends soon. */
export function bountyEndingSoonEmail(opts: {
  partnerName: string;
  brandName: string | null;
  bountyName: string;
  goal: string;
  progress: string;
  endsAt: Date;
  url: string;
}): EmailTemplate {
  const dateStr = opts.endsAt.toUTCString().replace(/ \d\d:\d\d:\d\d GMT$/, '');
  const subject = `"${opts.bountyName}" ends in 7 days`;
  const text = [
    `Hi ${opts.partnerName},`,
    ``,
    `The "${opts.bountyName}" bounty ends ${dateStr}.`,
    ``,
    opts.goal,
    `You're at ${opts.progress} so far.`,
    ``,
    opts.url,
  ].join('\n');
  return { subject, text, html: wrap(text, opts.url, 'See your progress') };
}

/** Partner: they reached a bounty and earned its bonus. */
export function bountyAwardedEmail(opts: {
  partnerName: string;
  brandName: string | null;
  bountyName: string;
  amount: string;
  held: boolean;
  url: string;
}): EmailTemplate {
  const fromBrand = opts.brandName ?? 'the program';
  const subject = `You earned ${opts.amount}: "${opts.bountyName}"`;
  const text = [
    `Hi ${opts.partnerName},`,
    ``,
    `You reached the "${opts.bountyName}" bounty from ${fromBrand} and earned a ${opts.amount} bonus.`,
    ``,
    opts.held
      ? `It shows on your Commissions page now, and is paid with your other earnings once the program's holdback ends.`
      : `It shows on your Commissions page now, and is paid with your other earnings.`,
    ``,
    opts.url,
  ].join('\n');
  return { subject, text, html: wrap(text, opts.url, 'View your earnings') };
}

// ---------------------------------------------------------------------------
// Brand review (approval gate) — brand-facing + platform-ops-facing.
// ---------------------------------------------------------------------------

/** Brand admin: your brand cleared review and is live. */
export function brandApprovedEmail(
  adminName: string,
  brandName: string,
  enterUrl: string,
): EmailTemplate {
  const subject = `${brandName} is approved — you're live`;
  const text = [
    `Hi ${adminName},`,
    ``,
    `Good news — ${brandName} has been approved on OpenPartner. Your`,
    `partner links now redirect, and you can invite partners and go live.`,
    ``,
    `Jump back into your dashboard:`,
    ``,
    enterUrl,
  ].join('\n');
  return { subject, text, html: wrap(text, enterUrl, 'Open dashboard') };
}

/** Brand admin: your brand was rejected. Only sent when the operator opts
 *  to notify — spam/phishing rejections are silent by default. No CTA:
 *  there's nowhere to send them. */
export function brandRejectedEmail(brandName: string, reason: string | null): EmailTemplate {
  const subject = `Your ${brandName} application wasn't approved`;
  const text = [
    `Hello,`,
    ``,
    `After review, we're unable to approve ${brandName} for OpenPartner at`,
    `this time.`,
    ...(reason ? [``, `Reason: ${reason}`] : []),
    ``,
    `If you believe this was a mistake, reply to this email and our team`,
    `will take another look.`,
  ].join('\n');
  const html = plainHtml(text);
  return { subject, text, html };
}

/** Platform operator: magic-link sign-in to the ops console. */
export function platformAdminSigninEmail(link: string): EmailTemplate {
  const subject = `Your OpenPartner ops sign-in link`;
  const text = [
    `Click the link below to sign in to the OpenPartner platform-ops console:`,
    ``,
    link,
    ``,
    `This link is good for 15 minutes. If you didn't request it, ignore this`,
    `email — someone may have mistyped their address.`,
  ].join('\n');
  return { subject, text, html: wrap(text, link, 'Sign in to ops') };
}

/** Unified sign-in matched no brand admin for this address. Sent only where
 *  the reader can act on it (routes/signin.ts): an ops-console address gets
 *  pointed at the ops console; anyone else gets the ways to a brand account. */
export function signinNoAccountEmail(opts: {
  email: string;
  /** Set when the address is an ops-console operator. */
  opsConsoleUrl: string | null;
  signupUrl: string;
}): EmailTemplate {
  const subject = `No OpenPartner brand account for this address`;
  const opening = [
    `Someone asked for an OpenPartner sign-in link for ${opts.email}, but this`,
    `address isn't an admin on any brand, so no link was sent.`,
    ``,
  ];
  const closing = [``, `If you didn't ask for a link, ignore this email. Nothing changed.`];
  if (opts.opsConsoleUrl) {
    const text = [
      ...opening,
      `It is an ops-console address. Sign in to the ops console here:`,
      ``,
      opts.opsConsoleUrl,
      ``,
      `To work in a brand, sign in with the address that brand's team invited,`,
      `or ask one of its admins to invite this address.`,
      ...closing,
    ].join('\n');
    return { subject, text, html: wrap(text, opts.opsConsoleUrl, 'Open the ops console') };
  }
  const text = [
    ...opening,
    `If that was you, sign in with the address your brand's team invited, or ask`,
    `one of its admins to invite this address. To start a brand of your own:`,
    ``,
    opts.signupUrl,
    ``,
    `If this address has a creator account, its creator sign-in link comes in a`,
    `separate email.`,
    ...closing,
  ].join('\n');
  return { subject, text, html: wrap(text, opts.signupUrl, 'Create a brand') };
}

/** Platform ops: a new brand signed up and is waiting for review. */
export function opsBrandNeedsReviewEmail(
  brandName: string,
  slug: string,
  adminEmail: string,
  reviewUrl: string,
): EmailTemplate {
  const subject = `[Review] ${brandName} (${slug}) signed up`;
  const text = [
    `A new brand is waiting for review:`,
    ``,
    `  Brand:  ${brandName}`,
    `  Slug:   ${slug}`,
    `  Admin:  ${adminEmail}`,
    ``,
    `Approve or reject it in the ops console:`,
    ``,
    reviewUrl,
  ].join('\n');
  return { subject, text, html: wrap(text, reviewUrl, 'Review brand') };
}

/** Platform ops: an existing brand, asked where it's based, named a
 *  country the platform doesn't serve (or answered from one). Ops close it
 *  through the review console. */
export function opsBrandCountryNotServedEmail(
  brandName: string,
  slug: string,
  declaredCountry: string,
  via: 'declared' | 'ip' | 'region',
  reviewUrl: string,
): EmailTemplate {
  const subject = `[Action] ${brandName} (${slug}) is in a country we don't serve`;
  const text = [
    `A brand answered the location question with a country the platform doesn't serve.`,
    ``,
    `  Brand:     ${brandName}`,
    `  Slug:      ${slug}`,
    `  Declared:  ${declaredCountry}`,
    `  Matched:   ${via === 'ip' ? 'the sign-in IP country' : 'the declared country'}`,
    ``,
    `Their sign-in is already refused from blocked countries. Review and reject the brand in the ops console:`,
    ``,
    reviewUrl,
  ].join('\n');
  return { subject, text, html: wrap(text, reviewUrl, 'Open review console') };
}

/** Platform ops: sanctions screenings came back with possible matches on
 *  the US Consolidated Screening List. A partner's Stripe payouts are held
 *  until an operator clears or confirms the match in the console. One
 *  email per screening run. Names only, no emails: the console has the
 *  rest. */
export function opsScreeningReviewEmail(opts: {
  items: Array<{
    subjectKind: 'tenant' | 'partner';
    brandName: string;
    slug: string | null;
    names: string[];
    topMatch: { source: string; name: string; score: number | null } | null;
  }>;
  reviewUrl: string;
}): EmailTemplate {
  const n = opts.items.length;
  const first = opts.items[0]!;
  const subject =
    n === 1
      ? `[Action] Sanctions screening: possible match for ${first.subjectKind === 'tenant' ? 'brand' : 'a partner of'} ${first.brandName}`
      : `[Action] Sanctions screening: ${n} possible matches to review`;
  const lines: string[] = [
    n === 1
      ? `${first.subjectKind === 'tenant' ? 'A brand' : 'A partner'} came back as a possible match on the US Consolidated Screening List.`
      : `${n} brands or partners came back as possible matches on the US Consolidated Screening List.`,
  ];
  for (const item of opts.items) {
    lines.push(
      ``,
      `  ${item.subjectKind === 'tenant' ? 'Brand:   ' : 'Partner of:'} ${item.brandName}${item.slug ? ` (${item.slug})` : ''}`,
      `  Screened:   ${item.names.join(', ')}`,
      ...(item.topMatch
        ? [
            `  Closest:    ${item.topMatch.name}${item.topMatch.score != null ? ` (score ${item.topMatch.score})` : ''}`,
            `  List:       ${item.topMatch.source}`,
          ]
        : []),
    );
  }
  lines.push(
    ``,
    `A partner's Stripe payouts are held until you clear or confirm the match. Confirming a brand's match rejects the brand. Review them in the ops console:`,
    ``,
    opts.reviewUrl,
  );
  const text = lines.join('\n');
  return { subject, text, html: wrap(text, opts.reviewUrl, 'Open screening review') };
}

/** Platform ops: the funding executor reached a partner who went on a
 *  compliance hold after their payout batch was reserved, and didn't make
 *  the transfer. The brand's payment for it was already collected, so the
 *  batch settles with a residual an operator has to dispose of. One email
 *  per executor run. */
export function opsFundedTransfersHeldEmail(opts: {
  items: Array<{
    brandName: string;
    slug: string | null;
    partnerName: string;
    reason: 'country_not_supported' | 'screening_confirmed' | 'screening_review' | 'screening_pending';
    /** Formatted, e.g. "50.00 USD". */
    amount: string;
    batchId: string;
  }>;
  reviewUrl: string;
}): EmailTemplate {
  const n = opts.items.length;
  const first = opts.items[0]!;
  const reasonText: Record<(typeof opts.items)[number]['reason'], string> = {
    country_not_supported: "declared country we don't serve",
    screening_confirmed: 'confirmed sanctions-list match',
    screening_review: 'possible sanctions-list match awaiting review',
    screening_pending: 'not screened yet',
  };
  const subject =
    n === 1
      ? `[Action] Funded payout stopped for a partner of ${first.brandName}: compliance hold`
      : `[Action] ${n} funded payouts stopped by compliance holds`;
  const lines: string[] = [
    n === 1
      ? `A partner went on a compliance hold after their funded payout batch was reserved, so their transfer was not made.`
      : `${n} partners went on compliance holds after their funded payout batches were reserved, so their transfers were not made.`,
  ];
  for (const item of opts.items) {
    lines.push(
      ``,
      `  Partner of: ${item.brandName}${item.slug ? ` (${item.slug})` : ''}`,
      `  Partner:    ${item.partnerName}`,
      `  Hold:       ${reasonText[item.reason]}`,
      `  Amount:     ${item.amount}`,
      `  Batch:      ${item.batchId}`,
    );
  }
  lines.push(
    ``,
    `The brand's payment for this money was already collected. The batch settles with a residual that needs a disposition: refund it to the brand, or credit it to the brand's next batch. Don't pay it out by hand while the hold stands. The partner's commissions stay approved and aren't batched again until the disposition is recorded.`,
    ``,
    `Review the holds in the ops console:`,
    ``,
    opts.reviewUrl,
  );
  const text = lines.join('\n');
  return { subject, text, html: wrap(text, opts.reviewUrl, 'Open screening review') };
}

/** Platform ops: self-hosted vendors registered on the Network and are
 *  waiting in the vendor review queue (nothing they publish lists until an
 *  operator approves them). */
export function opsNetworkVendorsPendingEmail(
  vendors: Array<{ name: string; instanceUrl: string }>,
  reviewUrl: string,
): EmailTemplate {
  const n = vendors.length;
  const subject =
    n === 1 ? `[Review] Network vendor ${vendors[0]!.name} is waiting` : `[Review] ${n} Network vendors are waiting`;
  const text = [
    `${n === 1 ? 'A self-hosted vendor has' : `${n} self-hosted vendors have`} joined the OpenPartner Network and ${n === 1 ? 'is' : 'are'} waiting for review.`,
    `Nothing they publish appears on the marketplace until approved.`,
    ``,
    // Indented so the HTML wrapper renders instance URLs as text, never links.
    ...vendors.map((v) => `  ${v.name} (${v.instanceUrl})`),
    ``,
    `Approve or reject in the ops console:`,
    ``,
    reviewUrl,
  ].join('\n');
  return { subject, text, html: wrap(text, reviewUrl, 'Review vendors') };
}

/** Platform ops: a decision was recorded (audit copy to the ops inbox). */
export function opsBrandDecisionEmail(
  brandName: string,
  slug: string,
  decision: 'approved' | 'rejected' | 'reinstated',
  operatorEmail: string,
  reason: string | null,
): EmailTemplate {
  const subject = `[${decision}] ${brandName} (${slug})`;
  const text = [
    `${brandName} (${slug}) was ${decision} by ${operatorEmail}.`,
    ...(reason ? [``, `Reason: ${reason}`] : []),
  ].join('\n');
  return { subject, text, html: plainHtml(text) };
}

/** Platform ops: a hosted brand scheduled their subscription to cancel at
 *  period end (usually via the Stripe Customer Portal). */
export function opsTenantCancellationScheduledEmail(
  brandName: string,
  slug: string,
  effectiveAt: Date | null,
  customerFeedback: string | null,
  stripeSubscriptionUrl: string,
): EmailTemplate {
  const subject = `[Billing] ${brandName} (${slug}) scheduled a cancellation`;
  const text = [
    `${brandName} (${slug}) scheduled their OpenPartner subscription to cancel${
      effectiveAt ? ` on ${effectiveAt.toISOString().slice(0, 10)}` : ' at the end of the current period'
    }.`,
    ...(customerFeedback ? [``, `Customer feedback: ${customerFeedback}`] : []),
    ``,
    `White-label branding + custom-domain routing will be revoked automatically`,
    `when the subscription actually ends. Review the subscription in Stripe:`,
    ``,
    stripeSubscriptionUrl,
  ].join('\n');
  return { subject, text, html: wrap(text, stripeSubscriptionUrl, 'View subscription in Stripe') };
}

/** Platform ops: a previously scheduled cancellation was removed. */
export function opsTenantCancellationResumedEmail(brandName: string, slug: string): EmailTemplate {
  const subject = `[Billing] ${brandName} (${slug}) resumed their subscription`;
  const text = `${brandName} (${slug}) removed their scheduled cancellation — the subscription renews as normal.`;
  return { subject, text, html: plainHtml(text) };
}

/** Platform ops: a hosted brand's plan subscription ended. */
export function opsTenantSubscriptionEndedEmail(
  brandName: string,
  slug: string,
  via: 'webhook' | 'reconciliation',
  whiteLabelRevoked: boolean,
): EmailTemplate {
  const subject = `[Billing] ${brandName} (${slug}) subscription ended`;
  const text = [
    `The OpenPartner plan subscription for ${brandName} (${slug}) has ended${
      via === 'reconciliation'
        ? ` — caught by the nightly Stripe reconciliation, which means the Stripe webhook delivery was missed (check the endpoint's subscribed events)`
        : ''
    }.`,
    ``,
    `Local billing state cleared.${whiteLabelRevoked ? ' White-label disabled and custom-domain routing revoked.' : ''}`,
    `The brand keeps its data and can re-subscribe from the portal.`,
  ].join('\n');
  return { subject, text, html: plainHtml(text) };
}

/** Platform ops: a brand's Stripe App connection stopped refreshing, so
 *  its Stripe events are skipped until the brand reconnects. */
export function opsStripeAppReconnectEmail(
  brandName: string,
  slug: string,
  stripeAccountId: string,
  error: string,
): EmailTemplate {
  const subject = `[Stripe App] ${brandName} (${slug}) needs to reconnect Stripe`;
  const text = [
    `Stripe refused to refresh the Stripe App connection for ${brandName} (${slug}), account ${stripeAccountId}.`,
    `Stripe said: ${error}`,
    ``,
    `Until the brand reconnects (Admin → Integrations → Connect Stripe), its Stripe events are acknowledged`,
    `and skipped: checkouts, invoices, refunds and promo-code redemptions from that account are not recorded.`,
    `The portal already shows the brand a "reconnect needed" banner.`,
  ].join('\n');
  return { subject, text, html: plainHtml(text) };
}

/** Platform ops: Stripe failed to collect a tenant's own OpenPartner
 *  invoice (dunning). */
export function opsTenantInvoicePaymentFailedEmail(
  brandName: string,
  slug: string,
  amountDue: string,
  attemptCount: number,
  invoiceUrl: string | null,
): EmailTemplate {
  const subject = `[Billing] Payment failed for ${brandName} (${slug}) — ${amountDue}`;
  const text = [
    `Stripe failed to collect ${amountDue} from ${brandName} (${slug}) (attempt ${attemptCount}).`,
    ``,
    `Stripe keeps retrying on its dunning schedule. If this brand has cancelled`,
    `or the amount isn't actually owed, void the invoice in Stripe to stop the retries.`,
    ...(invoiceUrl ? [``, invoiceUrl] : []),
  ].join('\n');
  return {
    subject,
    text,
    html: invoiceUrl ? wrap(text, invoiceUrl, 'View invoice in Stripe') : plainHtml(text),
  };
}

/** Platform ops: the nightly hard delete failed for brands whose 30-day
 *  deletion grace window has lapsed. Their data is still on file. */
export function opsTenantPurgeFailedEmail(
  failures: Array<{ tenantId: string; slug: string; displayName: string; pendingDeletionAt: Date; error: string }>,
): EmailTemplate {
  const n = failures.length;
  const subject =
    n === 1
      ? `[Deletion] Hard delete failed for ${failures[0]!.displayName} (${failures[0]!.slug})`
      : `[Deletion] Hard delete failed for ${n} brands`;
  const text = [
    `The nightly hard delete failed for ${n === 1 ? 'a brand' : `${n} brands`} past the 30-day deletion grace window.`,
    `Each purge rolled back, so ${n === 1 ? 'its' : 'their'} data is still on file. The job retries daily.`,
    ``,
    ...failures.flatMap((f) => [
      `  ${f.displayName} (${f.slug}), tenant ${f.tenantId}`,
      `    Deletion requested: ${f.pendingDeletionAt.toISOString().slice(0, 10)}`,
      `    Error: ${f.error}`,
    ]),
  ].join('\n');
  return { subject, text, html: plainHtml(text) };
}

// ---------------------------------------------------------------------------
// Platform → brand: setup reminders + marketplace policy notices. Sent in the
// platform voice (Message.platform), never brand-branded.
// ---------------------------------------------------------------------------

/** Brand admin: your setup is incomplete (step 1–3 of the reminder sequence). */
export function brandSetupReminderEmail(opts: {
  adminName: string | null;
  brandName: string;
  missing: string[];
  step: number;
  dashboardUrl: string;
  unsubscribeUrl: string;
  pendingReview: boolean;
}): EmailTemplate {
  const left = opts.missing.length;
  const subject =
    opts.step === 1
      ? `Finish setting up ${opts.brandName} on OpenPartner`
      : opts.step === 2
        ? `${opts.brandName}: ${left} step${left === 1 ? '' : 's'} left before partners can earn for you`
        : `Last reminder: ${opts.brandName} isn't fully set up on OpenPartner`;
  const text = [
    `Hi ${opts.adminName?.trim() || 'there'},`,
    ``,
    opts.step === 1
      ? `Thanks for signing ${opts.brandName} up for OpenPartner. A few steps are still open before partners can start sending you customers and getting credited for them:`
      : `${opts.brandName} still has ${left} setup step${left === 1 ? '' : 's'} open on OpenPartner:`,
    ``,
    ...opts.missing.map((m) => `  - ${m}`),
    ``,
    ...(opts.pendingReview
      ? [
          `Your brand is still in our review queue. You can finish all of this now, and it goes live the moment you're approved.`,
          ``,
        ]
      : []),
    `Pick up where you left off:`,
    ``,
    opts.dashboardUrl,
    ``,
    `Questions? Just reply to this email.`,
  ].join('\n');
  return {
    subject,
    text: `${text}\n\n--\nYou're receiving this because you manage ${opts.brandName} on OpenPartner. Stop setup reminders: ${opts.unsubscribeUrl}`,
    html: wrapWithFooter(
      text,
      opts.dashboardUrl,
      'Finish setup',
      `You're receiving this because you manage ${escapeHtml(opts.brandName)} on OpenPartner. <a href="${escapeHtml(opts.unsubscribeUrl)}" style="color:#6b7280">Stop setup reminders</a>.`,
    ),
  };
}

/**
 * Brand admin: a marketplace listing breaks the listing policy (typically,
 * it funnels creators to a different affiliate platform). Sent manually by
 * an operator from the ops console; `details` is the operator's own
 * explanation of what was found.
 */
export function marketplacePolicyWarningEmail(opts: {
  adminName: string | null;
  brandName: string;
  details: string;
  deadline: string;
  dashboardUrl: string;
}): EmailTemplate {
  const subject = `Action needed: your ${opts.brandName} marketplace listing`;
  const text = [
    `Hi ${opts.adminName?.trim() || 'there'},`,
    ``,
    `Listing on the OpenPartner marketplace is free because creators who find your program there join it, and are tracked and paid, through OpenPartner. Sending creators from your listing to sign up on a different affiliate platform, or to track their referrals elsewhere, isn't allowed.`,
    ``,
    `Here's what we found:`,
    ``,
    ...opts.details.split('\n').map((l) => `  ${l}`),
    ``,
    `Please update your listing by ${opts.deadline} so creators join and are credited through your OpenPartner program. If it isn't fixed by then, we'll remove the listing from the marketplace. Your OpenPartner account and existing partners aren't affected.`,
    ``,
    `Review your programs:`,
    ``,
    opts.dashboardUrl,
    ``,
    `If you think we've got this wrong, reply to this email and we'll take another look.`,
  ].join('\n');
  return { subject, text, html: wrap(text, opts.dashboardUrl, 'Review my programs') };
}

/**
 * Brand admin: the platform fee is changing (the Terms' 30 days' notice).
 * An essential contractual notice about the account, not marketing: it goes
 * to every admin and has no unsubscribe link, like a security or billing
 * notice. Sent only when an operator clicks send in the ops console.
 */
export function pricingChangeNoticeEmail(opts: {
  adminName: string | null;
  brandName: string;
  /** e.g. "3%" and "10%". */
  revenueRate: string;
  commissionRate: string;
  /** The commission share at or below which honest programs pay the same as
   *  today, e.g. "30%". */
  breakEven: string;
  effectiveDate: string;
  pricingUrl: string;
  billingUrl: string;
}): EmailTemplate {
  const subject = `Notice of a pricing change for ${opts.brandName} on OpenPartner, effective ${opts.effectiveDate}`;
  const text = [
    `Hi ${opts.adminName?.trim() || 'there'},`,
    ``,
    `We're changing how the OpenPartner platform fee is calculated. This email is the 30 days' notice our Terms require.`,
    ``,
    `What changes, from ${opts.effectiveDate} (the start of your first billing period after the notice period):`,
    `  - Your fee stays ${opts.revenueRate} of partner-attributed revenue, with a minimum of ${opts.commissionRate} of the commissions your partners earn on each conversion.`,
    `  - A conversion counts as revenue when it's an invoice or subscription payment, when it pays a percentage commission, or when you've marked its event type as revenue on a program.`,
    `  - A refund lowers the fee once the partner's commission on it is reversed or clawed back.`,
    ``,
    `What doesn't change:`,
    `  - If you pay partners up to ${opts.breakEven} of the revenue you report, you pay ${opts.revenueRate} of revenue, the same as today.`,
    `  - Conversions attributed before ${opts.effectiveDate} are billed as they are today.`,
    ``,
    `Pricing details: ${opts.pricingUrl}`,
    `Your billing page: ${opts.billingUrl}`,
    ``,
    `Questions? Just reply to this email.`,
  ].join('\n');
  const footer = `You're receiving this service notice because you're an admin of ${opts.brandName} on OpenPartner.`;
  return {
    subject,
    text: `${text}\n\n--\n${footer}`,
    html: wrapWithFooter(text, opts.pricingUrl, 'See pricing', escapeHtml(footer)),
  };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** {@link wrap} plus a small muted footer line (raw HTML — callers escape). */
function wrapWithFooter(text: string, cta: string, ctaLabel: string, footerHtml: string): string {
  const html = wrap(text, cta, ctaLabel);
  const row = `<tr><td style="padding:0 32px 22px; color:#6b7280; font-size:12px; line-height:1.5;">${footerHtml}</td></tr>`;
  const anchor = '</td></tr>\n        </table>';
  // Inside the card when the layout is the familiar one; otherwise still
  // present — an unsubscribe link must never silently disappear.
  return html.includes(anchor)
    ? html.replace(anchor, `</td></tr>\n          ${row}\n        </table>`)
    : html.replace('</body>', `<table role="presentation" align="center">${row}</table>\n  </body>`);
}

/** Plain-text-in-HTML wrapper for templates with no call-to-action button. */
export function plainHtml(text: string): string {
  return `<!DOCTYPE html>
<html>
  <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background:#f4f4f5; padding:24px 0; margin:0;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
      <tr><td align="center">
        <table role="presentation" width="520" cellspacing="0" cellpadding="0" border="0" data-op-email="card" style="background:#ffffff; border-radius:8px; overflow:hidden;">
          <tr><td style="padding:28px 32px; color:#1f2937; font-size:14px; line-height:1.6;">
            ${text
              .split('\n')
              .map((l) => l.replace(/</g, '&lt;').replace(/>/g, '&gt;'))
              .join('<br>')}
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;
}

function wrap(text: string, cta: string, ctaLabel: string): string {
  const escaped = text
    .split('\n')
    .map((line) =>
      line.startsWith('http')
        ? `<a href="${cta}" data-op-email="link" style="color:#2dd4bf">${cta}</a>`
        : line.replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    )
    .join('<br>');
  return `<!DOCTYPE html>
<html>
  <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background:#f4f4f5; padding:24px 0; margin:0;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
      <tr><td align="center">
        <table role="presentation" width="520" cellspacing="0" cellpadding="0" border="0" data-op-email="card" style="background:#ffffff; border-radius:8px; overflow:hidden;">
          <tr><td style="padding:28px 32px; color:#1f2937; font-size:14px; line-height:1.6;">
            ${escaped}
            <br><br>
            <a href="${cta}" data-op-email="button" style="display:inline-block; background:#2dd4bf; color:#041115; padding:10px 18px; border-radius:6px; text-decoration:none; font-weight:600;">${ctaLabel}</a>
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;
}
