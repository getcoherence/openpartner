# Renewals and the attribution window

A program's attribution window decides **acquisition**: which click gets
credit for a customer's first conversion. Once a customer has converted,
their renewals stay with the partner who won them for as long as they keep
paying, whatever the age of the click. The commission rule's own `recurring`
flag and `recurringMonths` cap decide how long those renewals pay.

The setting that controls this is `Program.renewalsStayWithPartner`. It is
on by default, for new programs and for every program that existed before
the setting was added.

Before this, the window was checked against every event, renewals included.
A customer who signed up 10 days after the click and paid monthly stopped
earning their partner anything about 12 months later, even under a rule
marked "20% recurring". The pricing page promises "attribution from click to
renewal", so this was a bug.

Code: `attributeEvent` and `priorConversions` in
[`apps/api/src/attribution.ts`](../apps/api/src/attribution.ts). Tests:
[`renewal-attribution.integration.test.ts`](../apps/api/src/__tests__/renewal-attribution.integration.test.ts).

## The rule

For each event, the engine looks at the customer's earlier attributed
events (same tenant, same `userId`, strictly earlier `ts`):

1. **Repeat → renewal.** If the customer already has an attributed event
   of the **same type**, this event keeps the attribution of the *first*
   one: the same clicks, partners, weights and model. The window is not
   consulted, and a newer click from another partner doesn't take it. The
   2nd, 13th and 40th `invoice_paid` all follow the first `invoice_paid`.
2. **First of its type → acquisition.** Otherwise the window decides, as it
   always has: the program's model over the clicks inside the window.
3. **First of its type, no click left in the window.** The event takes the
   attribution of the customer's most recent attributed event of any type.
   For example, a 90-day trial on a 60-day window: `signup` was attributed
   at day 10, and the first `invoice_paid` arrives at day 100. The customer
   was already won, so the partner keeps them.
4. Otherwise the result is `outside_window`, as before.

Then commission is evaluated per touch, as before, with one addition:

- **Past the window, only `recurring` sub-rules pay.** A touch whose click is
  older than its program's window (it reached the event through rule 1 or 3,
  not through the window) earns only on sub-rules with `recurring: true`,
  capped by `recurringMonths`. Non-recurring rules, such as a one-off
  `first` bounty or an `every` rule without the flag, pay only while the
  click is inside the window, which is exactly where they paid before. So
  turning this on never pays a rule that the brand didn't mark recurring
  for longer than it used to pay.
- `recurringMonths` is unchanged: it counts from the customer's first
  attributed event of the rule's type for that partner.
- `trigger: 'first'` / `'subsequent'`, the program's `endsAt`, partner
  commission overrides and slabs all apply exactly as they do for any
  other event.

With `renewalsStayWithPartner` **off**, rules 1 and 3 are skipped: every
event is attributed on its own against the clicks in the window, which is
the old behaviour.

## Edge cases

### The customer later clicks a different partner's link

**Renewals stay with the original partner. A new kind of conversion can go
to the new click.**

Partner A wins the customer. At day 390 the customer clicks partner B's
link, and at day 400 they renew:

- The day-400 `invoice_paid` is a repeat, so it goes to **A** (rule 1).
  Under the old rule, B would have taken it under last-click, because B's
  click was the newest one in the window.
- A first `addon_purchased` (or any type the customer has never converted
  on) at day 400 is an acquisition, so the window decides and **B** gets it
  (rule 2).

Why: a renewal is the same purchase continuing. Paying it to whoever the
customer last clicked lets any partner "steal" a subscriber with one click,
which is the opposite of the recurring revenue share the brand promised A.
A purchase of something new is a new conversion, so the program's model
decides it like any other. A brand that wants every payment to follow the
latest click, as in per-order retail affiliate programs, turns the setting
off.

### The original partner is revoked

**A revoked partner stops earning renewals, and nobody inherits their
share.**

Revocation already makes attribution skip the partner's clicks. A renewal
only reuses a touch whose click is still usable: not fraud-flagged, and its
partner not revoked.

- Single touch: the earlier conversion has no surviving touch, so it no
  longer anchors anything. The renewal is decided as if it were the first of
  its type (rule 2). If another partner has a click in the window, they win
  it, and their win then anchors the renewals after it. If not, the result
  is `no_click`.
- Multi-touch: the surviving partners keep exactly their original weights.
  The revoked partner's share is **not** re-normalised onto them, because
  that would be a windfall nobody earned. That share of the revenue simply
  isn't commissioned.

Past rows are left alone. Revocation has never rewritten the ledger: an admin
reverses specific commissions in the review queue.

A click flagged as fraud after the fact drops out of renewals the same way.

### The program's window changes later

**The window only affects acquisitions evaluated from then on.**

Shortening the window doesn't cut off customers who are already won,
because their renewals never look at it (rule 1). Lengthening it doesn't
reach back to events that already came out `outside_window`: attribution is
computed when an event arrives (or in a backlog replay), never recomputed on
a settings change. The one place the current window matters for a renewal
is the commission gate: whether the click is "past the window", and so
whether non-recurring rules pay, is measured against the window at the time
the event is attributed.

Flipping `renewalsStayWithPartner` behaves the same way. It decides events
attributed after the change, and existing rows stay as they are.

### Multi-touch models (linear, position)

**Renewals reuse the original weights and model.**

If the first `invoice_paid` was split linear 50/50 between A and B, every
renewal is split 50/50 between A and B with `model: 'linear'`. A partner who
touches the customer later doesn't join the split, and the split is never
recomputed. The program in control of a conversion is the one behind its
most recent click, which is the same rule that picks the model for a new
conversion. That program's `renewalsStayWithPartner` decides whether its
renewals are kept.

When an event has `Attribution` rows under more than one model (because
someone re-ran it with a `modelOverride`), the first-computed model is the
live one. A re-run with `modelOverride` uses only rows of that model.

### Corrective events

`refund`, `chargeback`, `dispute_created` and `invoice_payment_failed` never
take a renewal's attribution and never anchor one. Otherwise a refund dated
after the window would inherit the partner and, under a percent rule, accrue
a negative commission. Refunds and chargebacks correct the refunded
conversion's commissions themselves (`apps/api/src/refunds.ts`, from
`POST /attribution/refunds` or Stripe's `charge.refunded`). A dispute or a
failed payment is recorded and corrects nothing.

## Derived, not stored

Nothing records that a customer "belongs" to a partner. There's no owner
column, cache or flag. A renewal's attribution is read back each time from
the raw `Attribution × Event` rows (CLAUDE.md principle 1), using the
`Event(userId, ts)` index and the `Attribution(eventId, …)` unique key. That
means:

- **Re-derivable.** Replaying a customer's events in `ts` order rebuilds
  the same rows. The backlog replay (`attributeBacklogForUser`, run on a
  first identify stitch and on a fraud unflag) processes events oldest
  first, so a renewal recorded before its customer was stitched still finds
  its first conversion.
- **Idempotent.** Re-running a renewal derives the same `(eventId, model,
  clickId)` touches, so the unique key turns it into a no-op
  (`already_attributed`). A partner stitched to the customer later can't
  pick up an existing renewal on replay.
- **Portable.** An export carries `Attribution` and `Event`. An instance
  that imports them derives the same renewal attribution with no extra
  state. `renewalsStayWithPartner` travels on the `Program` row (bundle
  `schemaVersion` 5). Older bundles import with the column default, `true`.
  See [data-portability.md](data-portability.md).

## Configuration

- **API:** `renewalsStayWithPartner` on `POST /programs` and
  `PATCH /programs/{id}` (boolean, default `true`). It is returned on every
  `Program`.
- **Portal:** Admin → Programs. The checkbox "Renewals stay with the partner
  who earned the customer" is on the new-program form and the edit form.

It's a per-program setting in the database, not an environment variable,
because brands change it at runtime.
