# Tracking health

**Admin → Tracking health** shows where partner clicks and conversions go
missing. A list of tracked sales looks the same whether 2% or 20% of them
were lost on one browser or one checkout path. This page shows the gaps
instead, from the raw click, landing, identity and event records. Nothing on
it is stored separately: every number is recomputed from those records when
the page loads (`GET /admin/tracking-health`, admin only).

Pick a window (7, 30 or 90 days) and, optionally, one program.

## Flags

The rest of the page describes one window. Flags compare each browser and
each partner with its own recent past, which a single window can't show
(`GET /admin/tracking-health/flags`). They use fixed windows and cover the
whole account, whatever window or program is picked. Like the rest of the
page, they are recomputed from the raw records on every load. Every
threshold below is in one place in the code (`FLAG_THRESHOLDS` in
`apps/api/src/tracking-flags.ts`).

### A browser's clicks stopped landing, or being linked

Per browser and device (the rows under **By browser**), two rates:

- **landed**: the click reached a page running the script within a day;
- **linked**: the click was linked to a customer within a day (`identify()`,
  a Stripe checkout, a conversion call).

Clicks one to eight days old are compared with clicks 8 to 36 days old. Both
windows stop a day short of now, and both rates count only what happened
within a day of the click. Without that, this morning's clicks would count as
misses before they'd had a chance to land or be linked, and the recent week
would always look worse than the month before it.

A rate is flagged when all of these hold:

| | |
|---|---|
| Clicks | at least 100 recent and 200 baseline, after fraud flags and bots |
| Baseline | at least 20 landings (or links), so its rate means something |
| Size of the fall | the recent rate is at most 60% of the baseline rate |
| Not chance | a one-sided two-proportion z-score of 3 or more |

A fall in **landed** usually follows a change on your site: a new cookie
banner or consent setup, a redirect that drops `?cref=`, or a page that lost
the script tag. A fall in **linked** with landings intact points at what
happens between the visit and the signup: `identify()` called later, a new
signup flow, or storage the browser now clears sooner.

### A partner's sales follow their click within seconds

A browser extension or a coupon site that clicks the partner's link at
checkout takes the credit without bringing the customer, and its clicks land
seconds before the sale. Real buyers rarely pay that fast.

The sample is each customer's first sale credited through a click of the
partner's link: a conversion with a value, so a signup a minute after the
click (which is ordinary) isn't one. Renewals inherit the first sale's click
and would read as months, so they're left out. A coupon redemption's
synthetic click is stamped at checkout and would read as zero, so that's left
out too. Sales in the last 14 days are compared with the 90 days before.

With at least 5 recent sales, the partner is flagged when either:

| Reason | Means |
|---|---|
| Mostly instant | 60% or more of the recent sales came within 60 seconds of the click. No history needed. |
| Collapsed | with at least 10 baseline sales, the recent median is a tenth of the baseline median or less, and under 5 minutes. 30 minutes down to 10 seconds is flagged; 2 days down to 3 hours isn't. |

Look at where the partner's clicks come from before approving their
commissions.

### Email

New flags are emailed to every activated admin once a day (the
`tracking-alerts` job, 06:40 UTC). Each flag is emailed once when it first
appears, not every day it stays. A flag nobody has seen for three days
closes; if it comes back after that, it's emailed again, unless it was
emailed in the last seven days. The job needs the scheduler
(`OPENPARTNER_ENABLE_SCHEDULER=1` on a self-host).

It's on by default. **Email admins about new flags** beside the flags turns
it off (`POST /config/tracking-alerts` `{ "email": false }`). The setting
travels with an export; what was emailed when doesn't (see
[data portability](data-portability.md)).

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
| Missed sales | **not recorded, and it would have credited a partner** had it been |
| Not creditable | not recorded, and it carries a partner signal, but that signal wouldn't have credited anyone |
| No partner signal | not recorded, and nothing ties it to a partner: usually a customer who came on their own |

A partner signal is one of: the customer is linked to a partner click made
before the payment, the Checkout's `client_reference_id` is one of your
program's clicks (a Checkout that made an invoice counts for that invoice), or
it used a partner's code (its promotion code or Stripe coupon, on the invoice, a
line item or the Checkout). Codes are matched by id: a code you typed into a
promotion of your own matches only if it's the promotion recorded for the
partner's code.

Whether a signal would have credited is decided the way attribution would
have decided the payment had its webhook arrived when it was paid (an invoice's
paid time; a Checkout's creation, as Stripe doesn't record its completion),
for the customer the payment would be recorded under: the `openpartner_user_id`
on the Stripe customer, else the `cus_` id. It credits through a click that
isn't flagged and whose partner isn't revoked (as of now, as any replay is
judged), inside its program's attribution window; or through an earlier
credited conversion of the customer's that carries the payment the way a
renewal does (unless that program lets renewals go). A partner code still
active at the payment adds a click stamped then, unless the customer already
had a click of that partner's, which the redemption reuses whatever its age. A
signal that fails is **Not creditable**, counted by why:

| Why | Means |
|---|---|
| outside the window | usable partner clicks, all older than the program's window, and no earlier credited conversion carrying the customer |
| a code deactivated before the payment | the only partner code was deactivated before it was used |
| only flagged clicks or revoked partners | every click is flagged as fraud or belongs to a revoked partner |

**Missed sales** is the leak. The most recent (up to 50) are listed with a
link to each in your Stripe dashboard. The usual causes are a webhook that
never arrived and a payment OpenPartner couldn't map; open one in Stripe to see
which. A missed sale is about credit, not commission: once recorded, the
program's commission rules still apply.

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

## Partner codes

Per partner credited through a code in the window: the customers credited to
them, and how many of those came through the partner's code without ever
clicking the partner's own link first (**Code, no click of theirs**).
Customers, not conversions, so a customer's renewals count once. Only partners
with a code-credited conversion are listed, most clickless customers first.

A code that brings almost nobody through the partner's link (highlighted at 5
or more such customers and 80% or more of the partner's customers) may have
spread beyond the partner's audience: a coupon site, a browser extension. For a
podcast or video read, where people type the code they heard, it's normal.
Tracking is fine either way: this is about whether the credit is deserved.

## What it can't see

A sale that left no trace at all: no click kept in the browser or by your
server, no linked account, no partner code. No tool can credit those. What this
page shows are the common places where a trace starts and then stops.
