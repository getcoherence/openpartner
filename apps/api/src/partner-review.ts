/**
 * Review state for partners who applied through the public join page while
 * the program holds applications for review (partner_signup policy
 * 'require_review'). Stored on Partner.metadata.review, a server-owned key
 * (partner-signup strips it from public profiles), so it travels with the
 * row on export/import and needs no migration:
 *
 *   { status: 'pending',  appliedAt }              applied, not approved
 *   { status: 'approved', appliedAt, approvedAt }  approved by an admin via
 *                                                  POST /partners/:id/invite
 *
 * A pending applicant has no way to sign in: signup sends no magic link,
 * and /auth/magic/verify refuses a link for one.
 */

import type { PartnerRow } from '@openpartner/db';

export interface PartnerReview {
  status: 'pending' | 'approved';
  appliedAt: string;
  approvedAt?: string;
}

export function partnerReviewOf(metadata: unknown): PartnerReview | null {
  const review = (metadata as { review?: unknown } | null)?.review;
  if (!review || typeof review !== 'object') return null;
  const { status } = review as { status?: unknown };
  return status === 'pending' || status === 'approved' ? (review as PartnerReview) : null;
}

/** Applied for review and not yet approved (or activated some other way). */
export function isPendingReview(partner: Pick<PartnerRow, 'metadata' | 'activatedAt'>): boolean {
  return !partner.activatedAt && partnerReviewOf(partner.metadata)?.status === 'pending';
}
