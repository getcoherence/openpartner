# Tracking health

**Admin → Tracking health** shows where partner clicks and conversions go
missing. A list of tracked sales looks the same whether 2% or 20% of them
were lost on one browser or one checkout path. This page shows the gaps
instead, from the raw click, landing, identity and event records. Nothing on
it is stored separately: every number is recomputed from those records when
the page loads (`GET /admin/tracking-health`, admin only).

Pick a window (7, 30 or 90 days) and, optionally, one program.

## Partner link clicks

The window's clicks on partner links, after fraud flags and bots are taken
out. Coupon redemptions are not counted here, because nobody clicked them.

| Stage | Means | Comes from |
|---|---|---|
| Clicks | real visitors who clicked a partner link | the click router |
| Landed | the click reached a page running the OpenPartner script | the SDK's landing report (`POST /attribution/landing`) |
| Stitched | the click was linked to a customer | `identify()`, a Stripe checkout carrying the click, or a conversion call |
| Credited | the click earned at least one conversion | attribution |

**Landed** reads *Not measured* until the first landing report arrives. It
needs the current script tag or SDK on your site. A destination that sends
the visitor straight to a Stripe Payment Link never lands, by design.

A low landing rate usually means one of three things:

- a redirect on the landing page drops `?cref=`;
- the destination page doesn't carry the script tag;
- a consent banner holds the script back (`data-consent="pending"`) and the
  visitor never answered.

## Stripe revenue

Your own Stripe revenue next to what OpenPartner recorded from it and credited
to partners, payment by payment (`GET /admin/tracking-health/stripe`). It's
read from your Stripe account when the page loads, through the OpenPartner
Stripe App on OpenPartner Cloud or the instance's own `STRIPE_SECRET_KEY` on a
single-tenant self-host, and kept for ten minutes (**Read again** skips that).
Nothing is stored.

It reads the two kinds of payment OpenPartner records revenue from: paid
invoices (subscriptions and other invoices) and paid one-time Checkout
payments, created in the window. Each is one of:

| Column | Means |
|---|---|
| In Stripe | every such payment, gross (before refunds) |
| Recorded | OpenPartner recorded it |
| Credited to partners | recorded and credited to a partner |
| Missed | **not recorded, though it carries a partner signal**: the customer is linked to a partner click made before the payment, the Checkout's `client_reference_id` is one of your program's clicks (a Checkout that made an invoice counts for that invoice), or it used a partner's code (its promotion code or Stripe coupon, on the invoice, a line item or the Checkout) |
| No partner signal | not recorded, and nothing ties it to a partner: a customer who came on their own |

**Missed** is the leak. The payments are listed with a link to each in your
Stripe dashboard. Most are a webhook that never arrived; the rest are payments
OpenPartner couldn't map. Open one in Stripe to see why. Codes are matched by
id: a code you typed into a promotion of your own matches only if it's the
promotion recorded for the partner's code.

Totals are per currency, with your default currency first, and are never
added across currencies. Up to 2,000 invoices and 2,000 Checkout payments are
read per window (and up to 5,000 Stripe objects of each kind listed to find
them); the page says when there were more. Payments your backend
charges directly (a PaymentIntent outside invoices and Checkout) aren't read
from Stripe at all: report them with the conversions API.

It needs the Stripe connection to read invoices, Checkout Sessions and
customers. The page says so when the connection is missing, needs
reconnecting, or doesn't grant those.

## By browser

The same funnel per browser and device. A row whose stitch rate is well
below the account's (highlighted when it has at least 20 clicks and stitches
at under 60% of the overall rate) is where the click is lost between the
visit and signup:

- **Safari** deletes storage a page's scripts wrote after 7 days without a
  visit. Set the referral cookie from your own server
  (`referralCookieMiddleware` in `@openpartner/sdk/server`) and call
  `identify()` as early as you can.
- **In-app browsers** (Instagram, TikTok, Facebook) keep storage of their
  own, so a visitor who clicks inside the app and buys later in their usual
  browser arrives without the click. Only a stitch (an email capture or an
  account created in the in-app browser) carries it across.

## Conversions that credited nobody

The window's conversions with no partner credit, each with the first reason
the attribution engine stops at. Refunds and disputes are left out: they are
never credited by design.

| Reason | Means |
|---|---|
| No partner click on record | The customer was never linked to a partner click. Every customer who came without a partner is here too, so this is the most that could be missing, not what is. |
| Only excluded clicks | Every click behind the customer is flagged as fraud or belongs to a revoked partner. |
| Click outside the window | The customer's partner clicks are all older than the program's attribution window. |
| Recorded before the click was linked | A usable click inside the window and still no credit. The conversion arrived before its click was linked to the customer, and the call that linked it, `POST /attribution/conversions` with your own `userId`, credits only its own conversion. Link the click first (`identify()` or `POST /attribution/identify`, which also credits conversions already recorded for the user) and every conversion after it is credited. |

This section always covers the whole account: a conversion belongs to no
program until it is credited.

## Dropped by OpenPartner

Input OpenPartner had to reject, counted per day. Each one is a conversion
that may have belonged to a partner. The latest value seen is shown so you
can recognise your own typo.

| What | Usual cause |
|---|---|
| identify() named an unknown click | The script tag's `data-api-url` (or the SDK's `apiUrl`) names another program. |
| Landing report named an unknown click | The same. |
| Conversion or postback named an unknown click | The sender passes something other than the `{click_id}` it received. |
| Stripe checkout carried an unknown click | `client_reference_id` looks like a click id but isn't one of this program's: a stale link, or another program's script. |
| Stripe checkout carried your own reference | Your Checkout Sessions put your own order or user id in `client_reference_id`, so partner clicks can't ride on it. Pass the referral there, or link customers with `openpartner_user_id` metadata. |
| Coupon redemption with an unknown code | `POST /coupons/redeem` got a code no partner holds. |

These counts stay on the deployment that recorded them: they are not part of
an export (see [data portability](data-portability.md)).

## Credit decisions

- **Coupon took credit from a link**: conversions credited to a coupon's
  partner while another partner, whose link click was inside the window and
  who could have earned it (not flagged, not revoked), got nothing. Under
  last click the code, entered at checkout, is the most recent touch and
  wins. A multi-touch split that credits both isn't counted. To let the link
  win instead, turn on **Partner links beat coupon codes** for the code's
  program (Programs → Edit; `couponsYieldToLinks` on the API). It decides who
  wins a customer's first payment; renewals stay with that winner.
- **Stripe events recovered**: Stripe events the catch-up (every six hours,
  hosted Stripe connections) recorded after the webhook missed them. Any
  number above zero means webhook deliveries are failing.

## What it can't see

A sale that left no trace at all: a partner's visitor who blocked the script,
declined cookies and paid without an account. No tool can count those. What
this page does show is every point where a trace started and then stopped.
