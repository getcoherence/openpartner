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
  // No CTA button on this template — there's nowhere for the partner
  // to go. Plain-text-in-HTML is fine.
  const html = `<!DOCTYPE html>
<html>
  <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background:#f4f4f5; padding:24px 0; margin:0;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
      <tr><td align="center">
        <table role="presentation" width="520" cellspacing="0" cellpadding="0" border="0" style="background:#ffffff; border-radius:8px; overflow:hidden;">
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
  return { subject, text, html };
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

/** Plain-text-in-HTML wrapper for templates with no call-to-action button. */
function plainHtml(text: string): string {
  return `<!DOCTYPE html>
<html>
  <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background:#f4f4f5; padding:24px 0; margin:0;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
      <tr><td align="center">
        <table role="presentation" width="520" cellspacing="0" cellpadding="0" border="0" style="background:#ffffff; border-radius:8px; overflow:hidden;">
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
        ? `<a href="${cta}" style="color:#2dd4bf">${cta}</a>`
        : line.replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    )
    .join('<br>');
  return `<!DOCTYPE html>
<html>
  <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background:#f4f4f5; padding:24px 0; margin:0;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
      <tr><td align="center">
        <table role="presentation" width="520" cellspacing="0" cellpadding="0" border="0" style="background:#ffffff; border-radius:8px; overflow:hidden;">
          <tr><td style="padding:28px 32px; color:#1f2937; font-size:14px; line-height:1.6;">
            ${escaped}
            <br><br>
            <a href="${cta}" style="display:inline-block; background:#2dd4bf; color:#041115; padding:10px 18px; border-radius:6px; text-decoration:none; font-weight:600;">${ctaLabel}</a>
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;
}
