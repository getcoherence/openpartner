# Customer journey

For any customer, the brand can see every partner touch in order, link clicks and codes, alongside the customer's events. For each conversion, it shows who got the credit and why, and who each attribution model would have credited over the same touches. A dashboard says who won. An affiliate manager looking into a dispute, a suspicious partner or a model change needs the evidence behind that:

```
Ada · link click        Oct 1    from ada.blog         in window, no share
Bob · link click        Oct 13                         in window, no share
Cam · code CAM10        Oct 14   8 seconds before      credited 100%
invoice_paid  $100      Oct 14   credited to Cam 100%

Decided by the last click model over the 3 partner touches in the window.
Under first click: Ada 100%. Linear: Ada, Bob, Cam 33.3% each.
Position: Ada 40%, Cam 40%, Bob 20%.
```

The page is Admin → **Customer journey**. It opens from a commission's **Open** link on Commissions, or from **Journey** on a partner's referral. You can also look a customer up by the id your app sends to identify.

The API:
- `GET /events/{id}/journey`: the journey of that event's customer, explaining that event.
- `GET /customers/{userId}/journey`: the same journey looked up by your customer id. It explains `?eventId=`, or without it the customer's latest conversion.

Both are admin only. They name every partner who touched the customer, and they include your own userId.

The code:
- API: `apps/api/src/journey.ts` and `apps/api/src/routes/journey.ts`.
- The decision comes from `decideAttribution()` in `apps/api/src/attribution.ts`.
- Portal: `apps/portal/src/pages/admin/Journey.tsx`.

## Where it comes from

Nothing is stored for the journey. Everything is derived on each read:

- **Touches** come from the raw `Click` and `Identity` rows: every click linked to the customer, plus the synthetic click a code redemption records at checkout. Each touch carries:
  - the partner and program
  - where it came from (referer, UTM, sub-ID) and where it landed
  - whether the script reported the landing (`ClickLanding`)
  - the browser, device and country
  - when it was linked to the customer
- **The explanation** comes from `decideAttribution()`, the function `attributeEvent()` runs before it writes anything. So the journey can't drift from the engine: it is the engine's own decision, with a verdict for every click.
- **The credit** comes from the recorded `Attribution` and `Commission` rows. They stay the ledger's truth.

Because it's all derived from exported tables, a restored instance shows the same journeys ([data portability](data-portability.md)).

## What each touch's verdict means

| Verdict | Meaning |
|---|---|
| `credited` | Has a share of the credit (`weight`). |
| `in_window` | A candidate the model gave no share, for example an earlier click under last click. |
| `outside_window` | Older than its program's attribution window. |
| `after_event` | Came after the conversion. Clicks up to 5 minutes after are allowed for clock drift. |
| `yielded_to_link` | A code that gives way to a link click in the window, because its program has *Partner links beat coupon codes* on. |
| `flagged` | Fraud-flagged. Never counts. |
| `partner_revoked` | The partner has been revoked. |
| `no_program` | The click's program no longer exists. |

Each touch also has:
- `secondsBeforeEvent`: negative when the touch came after the conversion. A link click seconds before checkout is worth a look.
- `linkedAfterEvent`: true when the click was linked to the customer only after the conversion.

## How the credit was decided

`source` says which rule decided:

- **`window`**: the program's model ran over the touches in the window. Only then does `alternatives` list who each model (last click, first click, linear, position) would credit over the same touches, with the program's own model marked `live`.
- **`renewal`**: a repeat of a conversion the customer already made (a second `invoice_paid`, say). It keeps the touches of their first one ([renewal attribution](renewal-attribution.md)). `fromEvent` names that conversion. There are no alternatives, because the model doesn't decide a renewal.
- **`latest_conversion`**: no touch was left in the window, so the customer's latest conversion carried it.

A conversion nobody was credited for says why in `status`:
- `no_identity`: never linked to a partner click.
- `no_click`: every touch is flagged, or its partner is revoked.
- `outside_window`: no touch could take it, and no earlier conversion carries the customer. Each touch says why: outside its window, after the conversion, or its program deleted.
- `corrective`: a refund, chargeback, dispute or failed payment, which is never attributed.

## When today's data disagrees with the record

An event is attributed once. If something changes afterwards, today's decision can differ from what was recorded:
- a click is linked to the customer later (a second device logging in)
- a click is flagged
- a partner is revoked

Then `matchesRecord` is false and the page says so. The credit shown is still the recorded one, because that's what was earned and paid. Re-deciding an event is a ledger change, and the journey never makes it.

## What it can't show

Only partner touches reach OpenPartner. The script reports a landing only when the visit arrives from a partner link, so paid search, organic and direct visits are gaps between the steps, not missing steps. A code applied by a browser extension looks the same as one the customer typed. What the journey does show is whether the code's owner had any link click of their own before the sale. Tracking health counts the same thing per partner.

## Limits

A journey lists the newest 200 touches and the newest 200 events, plus the selected one, and says when it was cut (`truncated`). The decision always considers every linked click.
