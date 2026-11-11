# Setup wizard: first-run setup for new hosted brands

A new hosted brand is walked through the essentials on first sign-in instead of meeting the dashboard checklist cold: program, commission, tracking, marketplace, plan, then a recap. Self-hosted single-tenant installs don't get it; their first run is `/install`.

- **Switch:** ops console → Brands → "Setup wizard" (`PlatformSetting` key `setupWizard`, off by default). The same panel edits the hint line under the commission value; blank hides it. The hints are a starting point, not audited benchmark data.
- **Who sees it:** a multi-tenant brand with no program yet, or one that already started the wizard (`setupWizardStatus` in `apps/api/src/routes/onboarding.ts`). A brand that set itself up before the switch has programs and no start stamp, so it never does. Admins only; a view-only seat gets the dashboard.
- **Where:** `/t/<slug>/setup`, a page without the menu (`apps/portal/src/pages/admin/SetupWizard.tsx`). The dashboard sends an eligible brand there; "Finish later" on every step goes back to the dashboard, whose Getting started card then shows "Continue setup".

## What each step writes

Every step uses the routes the rest of the portal uses, so the Getting started card and the setup reminders reflect it.

| Step | Writes |
|---|---|
| Program | `POST /programs` with a 20% recurring rule and `shareOnNetwork: false` (`PATCH` on a later visit) |
| Commission | `PATCH /programs/:id`: one `every` rule, `attributionWindowDays`, `recruiterCommissionPercent` (on at 10% the first time, switchable off), `recruiterCommissionMonths: null` |
| Tracking | nothing required. "Send to a developer" is `POST /admin/tracking-health/send-to-developer`; "Send a test click" is the Tracking health one |
| Marketplace | `PATCH /programs/:id` `shareOnNetwork` + `marketplaceDescription`, or `shareOnNetwork: false` and the checklist's `networkListingSkipped`. Only for a brand on the Network that isn't white-label |
| Plan | `POST /billing/plan`, then for Flex `POST /billing/checkout` |

Progress is the Config key `onboarding` (`wizardStartedAt`, `wizardStep`, `wizardExitedAt`, `wizardCompletedAt`), set with `POST /config/onboarding`. The start stamp is written before the program is created: it, not "has no program", keeps the wizard open afterwards. A program whose rules were built on the Programs page keeps them; the commission step then only sets the window and the recruiter share.

Two-tier commission defaults on **in the wizard only**. A program created on the Programs page or through the API still has it off ([two-tier-commissions.md](two-tier-commissions.md)).

## "Send to a developer"

`{ email }` in; the server builds the mail (the script tag for this tenant, the `identify()` line, a link to the SDK README). Nothing from the request goes into the body. Five a day per brand, on the audit log, refused for view-only seats.

## The plan step and billing

- **Revshare** saves the plan and continues. No card. As before, a brand needs a subscription before its first partner joins, and is asked then.
- **Flex** goes to Stripe Checkout and returns to the recap (`?checkout=success`), which waits for the webhook. A cancelled Checkout (`?checkout=cancelled`) returns to the plan step with Flex kept; the brand can retry or switch.
- **A plan can be changed until a subscription exists** (`POST /billing/plan`); after that, through the Stripe Customer Portal as before.
- **Pay by invoice** (India by default): the plan and GSTIN are saved, and the brand starts the plan from Billing. An invoice subscription bills the moment it is created, so the wizard doesn't start one.
- **India paying by card:** the GSTIN is asked on the plan step, before Checkout.

### No charge during the sign-up trial

The 14-day trial starts at sign-up (`Tenant.trialEndsAt`). Checkout, from the wizard or the Billing page, on either plan, now passes the rest of that trial to Stripe as `subscription_data.trial_end` (`checkoutTrialEnd` in `billing-plan.ts`): the card is taken, and the first charge is on `trialEndsAt`.

This is not a second trial. It is never later than `trialEndsAt`, and with under 48 hours left (Stripe's minimum for a Checkout trial) or after the trial, Checkout charges at once as it always did. `trialEndsAt` stays owned by sign-up; the webhooks never write it.

Stripe does not bill metered usage recorded while a subscription is trialing, so the platform fee on partner-attributed sales made before `trialEndsAt` is not charged to a brand that subscribed during its trial.

### A brand that subscribes while in review

A pending brand can reach Checkout, so two things keep it from being charged before it is accepted:

- **Rejecting a brand cancels its subscription** (`cancelSubscriptionOnReject` in `billing-lifecycle.ts`). A trialing one has taken no money. If Stripe refuses, the rejection stands and ops gets an "ACTION NEEDED" mail with the subscription link.
- **A first charge that comes due while the brand is still pending moves out seven days** (`deferChargeWhilePendingReview`), each time it comes due, with a mail to ops. It runs on `customer.subscription.trial_will_end` and in the nightly billing reconcile, so it works even if the Stripe endpoint isn't subscribed to that event. Subscribing the endpoint to `customer.subscription.trial_will_end` makes it three days early instead of up to a day.

## Tests

`apps/api/src/__tests__/setup-wizard.test.ts`, the `trial_will_end` case in `stripe-webhook.test.ts`, and `apps/portal/src/__tests__/setup-wizard.test.tsx`.
