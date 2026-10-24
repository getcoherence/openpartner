# Referral timeline

Partners see each customer they referred, the stages that customer has
reached, and what the customer has earned them. Partners see it on the
**Referrals** page of the partner portal. A headless brand can render the
same data in its own app from `GET /partners/{id}/referrals`. The brand
chooses which stages partners see and what each stage is called.

Code: `apps/api/src/referrals.ts` (the query and the setting) and
`apps/api/src/routes/referrals.ts` (the routes). In the portal:
`apps/portal/src/pages/Referrals.tsx` and
`pages/admin/ReferralStagesSection.tsx`.

## What a referral is

A referral is one of your users (a `userId`) with at least one event
attributed to the partner, of any type, whether or not it earned anything.
So a CRM stage that pays nothing still shows the partner their customer
moving. Examples are `lead_created` and `demo_booked`, sent to
`POST /attribution/events` like any conversion. Before this, events that
earned nothing never reached the partner.

The list is derived from the raw Event and Attribution rows on every read,
like the rest of attribution. Nothing new is stored per referral.

## Stages: the brand's choice

Admin → Settings → **Referral stages**, or `POST /config/referrals`:

```json
{
  "stages": [
    { "eventType": "lead_created", "label": "Lead" },
    { "eventType": "demo_booked", "label": "Demo booked" },
    { "eventType": "deal_won", "label": "Deal won" },
    { "eventType": "invoice_paid", "label": "Paid" }
  ]
}
```

- **Order** is the order of the list. Partners see every stage in that
  order: reached ones carry a date, the others read "Not yet".
- **Default** (until you save your own): `signup` "Signed up",
  `trial_started` "Trial started", `subscription_created` "Subscribed",
  `invoice_paid` "Paid". These are the types OpenPartner records itself,
  and the funnel already shows them to partners.
- **Hidden types.** A type you don't list stays hidden from partners. Its
  type, dates and count never appear on the Referrals page, in
  `GET /partners/{id}/referrals`, or in `GET /partners/{id}/events` and
  `/customers` called as the partner. It still makes the customer a
  referral, and its commissions still count toward the customer's total.
  A commission line still names the event it was paid on
  (`GET /partners/{id}/commissions`), because a partner needs to know what
  they were paid for. To keep a stage's name entirely private, don't pay
  on it.
- `refund`, `chargeback`, `dispute_created` and `invoice_payment_failed`
  correct an earlier conversion and are never attributed, so they can't be
  stages (`400 corrective_stage`).
- At most 20 stages. A label is at most 60 characters. An empty list is
  allowed: partners then see their referrals and earnings with no steps.

The setting is per tenant, not per program. A customer's journey is one set
of events whatever program the click came through, and the event types are
your CRM's. The setting travels with a data export (`Config` key
`partner_referrals`, see [data-portability.md](data-portability.md)).

## Customer labels: off unless you turn them on

OpenPartner stores only your `userId` for a customer, never a name. With
customer labels off (the default), partners see a referral as "Referral #12".
The number counts the partner's referrals in the order they were referred.

To show a name, send it on the customer's events:

```json
{ "userId": "zoho-acc-1001", "type": "lead_created", "metadata": { "customerLabel": "Indus Textiles Pvt Ltd" } }
```

Then turn on **Show partners the customer label you send** in Settings, or
send `{"showCustomerLabels": true}` to `POST /config/referrals`. The newest
label on any of the customer's credited events wins. Labels are trimmed and
cut to 80 characters.

**This is your decision, as the controller of that data.** A company name,
or a person's name, is personal data about your customer. Sending it and
showing it to your partners is a disclosure you decide on and must be able
to justify, for example because the partner introduced that customer to
you. OpenPartner only displays what you send, and only while the setting is
on. Turn the setting off and labels disappear from partners' views at once.
The label stays in the event's metadata, which is your own raw data and is
part of every export.

## Partners never see your userId

A partner gets a `referralId` instead: `ref_` followed by 12 characters,
an HMAC of (tenant, userId) under the server's secret. It is the same
customer's id everywhere: `/referrals`, `/customers` and `/events`. It
can't be reversed, and a partner can't confirm a guessed userId with it.
It changes if the deployment's `SECRETS_ENCRYPTION_KEY` changes, so on a
restored self-hosted copy it differs. Key your own records on the userId,
not on `referralId`.

`GET /partners/{id}/customers` and `GET /partners/{id}/events` work the
same way: a partner calling gets `userId: null` and the `referralId`, while
admins and scoped keys still get the `userId`.

## Reading it from the API

```http
GET /partners/{id}/referrals?limit=50&cursor=<nextCursor>
```

A partner can read only their own referrals. Admins, and scoped keys with
`partners:read`, can read any partner's. A revoked partner's referrals stay
readable to you as history. The partner can't read them: revoking ends
their sessions and keys, and a key minted for them afterwards doesn't
authenticate (`401`) until they're reinstated.

```json
{
  "partnerId": "01J…",
  "stages": [{ "eventType": "lead_created", "label": "Lead" }, …],
  "currency": "INR",
  "total": 6,
  "nextCursor": "…",
  "referrals": [
    {
      "referralId": "ref_Xk3dP0aQm9Lc",
      "number": 1,
      "label": "Referral #1",
      "customerLabel": null,
      "userId": "zoho-acc-1001",
      "referredAt": "2026-08-25T10:00:00.000Z",
      "stages": [
        { "eventType": "lead_created", "label": "Lead", "firstAt": "…", "lastAt": "…", "count": 1, "reversed": false },
        { "eventType": "invoice_paid", "label": "Paid", "firstAt": "…", "lastAt": "…", "count": 2, "reversed": false }
      ],
      "latestStage": { "eventType": "invoice_paid", "label": "Paid", "at": "…" },
      "commission": 5300,
      "commissionByCurrency": { "INR": 5300 }
    }
  ]
}
```

- **Order:** newest referral first, meaning the customer who most recently
  became the partner's referral, and `number` counts up in the same order.
  A new referral always takes the next number. Keyset-paginated: pass
  `nextCursor` back as `cursor`. The cursor is encrypted, so it carries no
  readable userId or date.
- `referredAt` is when the customer first clicked the partner's link (the
  earliest of the partner's clicks credited on their events). That is the
  partner's own traffic, so it never reveals when a hidden event happened.
- `userId` appears only for admins and scoped keys. A headless brand can
  use it to show the customer's name from its own records, without sending
  a label to OpenPartner.
- `stages` lists the shown stages the customer reached, in your order.
  `firstAt` is when they reached it, and `count` and `lastAt` cover repeats
  such as monthly invoices.
- `latestStage` is the furthest stage reached in your order, skipping
  reversed ones.
- `number` only changes if an admin re-runs attribution for the customer
  (unflagging a fraud-flagged click). `referralId` never changes.

## Reversals

- `commission` counts the customer's live commissions for this partner, net
  of refund clawbacks, in your default currency. `commissionByCurrency`
  holds every currency, never added together. Every event type counts,
  hidden ones included. Reversed commissions don't count. Bonuses aren't
  tied to a customer, so they never count here. This is the same measure
  performance bounties use.
- A stage is `reversed: true` when every one of its events earned the
  partner a commission and none of it is left: reversed by a refund, a
  chargeback or an admin, or clawed back after payment. The portal strikes
  it through and marks it "reversed". A stage that never paid anything is
  never "reversed": it happened, and nothing was taken back.

## Related

- [headless-referral.md](headless-referral.md): the in-app guide. Step 5
  covers showing referrals; step 10 covers sending CRM stages.
- The partner-facing explanation is on the docs site: Partners → Referrals.
