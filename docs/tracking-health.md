# Tracking health

**Admin → Tracking health** shows where partner clicks and conversions go
missing. A list of tracked sales looks the same whether 2% or 20% of them
were lost on one browser or one checkout path. This page shows the gaps
instead, from the raw click, landing, identity and event records. Nothing on
it is stored separately: every number is recomputed from those records when
the page loads (`GET /admin/tracking-health`, admin only).

Pick a window (7, 30 or 90 days) and, optionally, one program.

## Setup checks

The first section says, step by step, whether your tracking works at all
(`GET /admin/tracking-health/setup`). Flags and the numbers below compare
your account with its own past or describe one window, so an account whose
tracking never worked would otherwise read as nothing unusual. Each check
is one of:

| Status | Means |
|---|---|
| passing | the step works |
| failing | it doesn't, and the check says what to change |
| waiting | too soon to tell: too few clicks yet, a program days old, or an earlier step that has to pass first |
| can't check | OpenPartner couldn't look: your site turned its request away, or your Stripe connection can't read what the check needs |

They run per active program (started, not ended, not taken down),
in the order a click travels, and then for the whole account:

| Check | Passes when |
|---|---|
| Partners can share it | a partner has a link or a code for the program. A program less than a week old is still waiting for its first. |
| Destination keeps the click | the program's destination answers (2xx) after its redirects, and the click is still there at the end: `?cref=` on the final address, the click id wherever your `{click_id}` put it, or in a cookie your server set on the way that the final page receives. A Stripe Payment Link isn't fetched (each visit opens a Checkout Session); it passes when it carries `client_reference_id={click_id}`. |
| Clicks reach the script | the program's partner clicks reach a page running the OpenPartner script. Fails when none ever has (in the last 90 days, or over the last year if fewer than 10 clicks came in the last 90), or when none has since a date after which that many misses would happen by chance less than once in a thousand at the program's own landing rate. Clicks that are linked to a customer anyway pass: your server reads the click another way. Not run for a Stripe Payment Link, where nothing lands. |
| Clicks are linked to customers | the partner clicks that reached your site are linked to a customer (`identify()`, a Stripe checkout, a conversion call). Fails when 100 or more reached it in the last 90 days and none was linked, or when the links stopped (the same one-in-a-thousand rule). Clicks less than a week old aren't judged: a signup can come days after the visit. |
| Stripe events arrive | your Stripe connection isn't waiting for a reconnect and wasn't uninstalled, and when Stripe shows a payment from the last 7 days that's at least 6 hours old, a payment event (`invoice.paid`, `checkout.session.completed`) reached OpenPartner after it. A payment is an invoice paid with an amount, by when it was paid, or a paid Checkout with an amount, at least a day old (so it has completed); zero-value invoices, setup-mode and still-unpaid Checkouts don't count. Only payments since OpenPartner began logging this account's events are compared: since the connection, or on a self-host, since the update that added the log. Only when Stripe is connected (or, on a single-tenant self-host, the instance's own `STRIPE_SECRET_KEY`). |
| Partner codes have their discount | each partner code that promises customers a discount has its promotion code in your Stripe, two hours after it was issued. A failing check quotes Stripe's last answer for a refused code. A code you mapped onto a promotion of your own isn't counted. On OpenPartner Cloud it doesn't pass until the codes have been checked against the account you connected (it waits a day for that, then says it can't check). Without a Stripe connection that can create discounts, it can't check. |

Clicks here are partner-link clicks from browsers (not bots), not flagged as
fraud, and at least a day old, so they've had their chance to land.

The destination is fetched from OpenPartner's servers with the user agent
`OpenPartner-SetupCheck/1` and a click id of 26 zeros, never through your
partner links, so no click is recorded and no partner is credited. It follows
up to six redirects, each through the same address checks as webhooks,
sending back the cookies each hop set as a browser would, and a page that
doesn't answer (or answers 5xx) is tried once more. Each hop has six seconds,
the whole fetch fifteen, and each Stripe read eight, with no retries. Sites behind
bot protection often turn it away; the check then says so and asks you to open
a partner link yourself. When the final page is HTML, the check also looks for
`/op.js` and mentions it when clicks aren't landing; the npm SDK is bundled
into your own scripts, so its absence from the page proves nothing.

The fetches and the Stripe read are kept for ten minutes; **Check again**
runs them afresh. Every threshold is in `SETUP_THRESHOLDS`
(`apps/api/src/setup-checks.ts`).

### Send a test click

The checks above judge your chain from real partner clicks, so until a
partner sends one they can only wait. **Send a test click**, beside each
program, proves the chain yourself: it opens a new tab on a single-use test
link, and follows that click as it travels:

| Step | Done when |
|---|---|
| Link opened | the router sent the click to the program's destination, with its click id where a partner's click would carry it (`?cref=`, or your `{click_id}`), and set the same cookie. |
| Reached the script | the OpenPartner script on the page reported the click landing (`POST /attribution/landing`). Also done when the click was linked without a landing report: your server reads the click another way. |
| Linked to a signup | your site linked the click to a signup or login (`identify()` or `POST /attribution/identify`). Sign up or log in in the tab the link opened; a private window helps if you're already signed in there. |

The first step that didn't happen says what to fix, in the same words as
the checks above: after a minute without a landing report, and three
minutes after the landing without a signup. A step that arrives late still
turns done. The page asks every two seconds until the test passes or
expires. Until it's opened, the link can be opened again from the page or
copied, to try a phone or another browser.

The test runs in your own browser, so its privacy settings count. If your
script tag waits for consent (`data-consent="pending"`), a browser that
sends Global Privacy Control or Do Not Track (Brave does by default) can
keep the script from reporting the click, even after you accept your
banner: the SDK's regional mode, and many banners, read the signal as a
decline. The fix for **Reached the script** says so, and when the browser
you sent the test from sends a signal, the page says that too. Send the
test from a browser without one.

**A test click is never a partner click.** It's recorded only on the test,
never as a click, so it's credited, paid and counted nowhere: not in
attribution or payouts, not in any click count, funnel or partner's numbers,
not in fraud review, and not in an export. No partner is involved, so a
program can be tested before its first partner joins. Your site's landing
report and identify call for it answer `test: true`; the signup is not
stitched to anything, and the user id isn't kept. If the tester goes on to
buy, the test click credits nobody: the sale is credited only as it would be
without it (a partner's code entered at checkout, or a customer already
linked to a partner), so test with a code of your own, not a partner's. A
checkout or conversion call carrying the test click id isn't counted under
**Dropped by OpenPartner**.

Only an admin can make one (`POST /admin/tracking-health/test-click`
`{ "programId": … }`, then `GET /admin/tracking-health/test-click/<id>`).
The test link is `/r/_test/<token>` under your share-link address: the token
is random, kept only as a hash, and works once, so nobody can mark a click of
their own as a test. It must be opened within 30 minutes. The landing and the
signup count for 24 hours after the click. An account can make 20 a day. A
program that sends partners straight to a Stripe-hosted checkout gets no
button: nothing lands there, and the destination check covers it. While an
account is waiting for approval its links record no clicks, so a test can't
be sent either. Tests are deleted 90 days after they were made (the
`test-click-purge` job, 06:50 UTC); until then, the test click id stored in
the tester's browser is still recognised, so a later signup there isn't
counted as an unknown click.

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

The sample is the first sale credited through each click of the partner's
link: a conversion with a value, so a signup a minute after the click (which
is ordinary) isn't one. A repeat purchase through a new click counts. A
renewal that stays with the partner is credited through its first sale's
click and would read as months, so it's left out. In a program that lets
renewals go, a renewal credited through a newer click is that click's first
sale and counts. A coupon redemption's synthetic click is stamped at checkout
and would read as zero, so that's left out too. Sales in the last 14 days are
compared with the 90 days before.

With at least 5 recent sales, the partner is flagged when either:

| Reason | Means |
|---|---|
| Mostly instant | 60% or more of the recent sales came within 60 seconds of the click. No history needed. |
| Collapsed | with at least 10 baseline sales, the recent median is a tenth of the baseline median or less, and under 5 minutes. 30 minutes down to 10 seconds is flagged; 2 days down to 3 hours isn't. |

Look at where the partner's clicks come from before approving their
commissions.

### Email

Setup checks that turn failing, and new flags, are emailed to every
activated admin once a day (the `tracking-alerts` job, 06:40 UTC), in one
email: failing checks first. The job runs the checks afresh each time.

A check is emailed when it goes from passing, waiting or unchecked to
failing, and a flag when it first appears; neither is emailed again every day
it stays. A check that's waiting or can't be checked is never emailed. If no
admin could be emailed, the next run tries again; if some could, the ones
whose email failed aren't sent it again, and it stays on the page. A check or
flag nobody has seen fail for three days closes; if it comes back after that,
it's emailed again, unless it was emailed in the last seven days.

The first run that checks an account's setup emails one list of whatever
fails then. After that, a check is emailed only when it turns failing.

The job needs the scheduler (`OPENPARTNER_ENABLE_SCHEDULER=1` on a
self-host).

It's on by default. **Email admins about failing checks and new flags**
beside the setup checks turns it off (`POST /config/tracking-alerts`
`{ "email": false }`). The setting travels with an export; what was emailed
when doesn't (see [data portability](data-portability.md)).

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
| Stripe refused a partner code's discount | Your Stripe wouldn't create the promotion code for a partner's code, so customers who enter it pay full price. Stripe's answer is shown under the code, and **Partner codes have their discount** above counts the codes still without one. OpenPartner Cloud retries every hour, so this can count many times a day. |

A [test click](#send-a-test-click)'s id is never counted here.

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
