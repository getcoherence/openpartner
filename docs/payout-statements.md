# Payout statements

A payout statement is remittance advice for one payout: who paid whom, how,
and for what. The brand keeps it for its books and sends it to the partner;
the partner opens their own from the portal. It is built from the payout's
records each time it is opened (apps/api/src/payout-statements.ts), so it
always agrees with them, and nothing about it is stored.

**It is not a tax invoice.** See [Tax](#tax) before turning on anything
tax-related.

## What it shows

- **The brand.** Its legal name and address from the statement settings
  (below), falling back to the program name. On OpenPartner Cloud, the
  GSTIN on the brand's billing profile (Admin → Billing). The brand's logo.
- **The partner.** Name, email, partner id, and where the payout went,
  **masked**. A full account number, email or UPI ID is never shown.
  - Stripe: the last four characters of the account the transfer was frozen
    to (`Payout.metadata.destinationAccountId` for a direct Connect intent,
    the funding transfer's `destinationAccountId` for a funded one). An
    older payout that froze neither says "not recorded" rather than naming
    the partner's account now, which may be a different one.
  - Manual: the partner's payout details on file now, as `summarizeDetails`
    prints them (`PayPal j•••@example.com`, `Bank account •••• 1234 (INR)`,
    `UPI a•••@okaxis`). If they changed after the payout went into a batch
    file (or, sent one at a time, after it was confirmed), the statement
    says so.
- **The payout.** Statement number, payout id, status, how it was sent
  (Stripe Connect, or manual: PayPal Payouts file, Wise batch file, bank
  transfer, UPI, other) and its reference where there is one: the Stripe
  transfer id, or the PayPal Customer ID or Wise payment reference it
  carried in a batch file. A Wise reference depends on the account's
  currency (there is none for JPY or COP), so it is left off once the
  partner's details have changed since the file.
- **Line items.**
  - each commission: the date it was earned, the program, the event it was
    earned on (`Invoice paid`, `Trial started`, a custom type) and the amount;
  - each bonus: date, program, and the bonus's note or bounty;
  - each refund clawback netted off this payout
    (docs/refund-clawback-netting.md), as a negative line naming the
    commission it claws back;
  - Stripe transfer reversals after the payout was paid, as information.
    They are not in the totals; the statement shows what the partner kept
    after them.
- **Totals, per currency.** Commissions, bonuses, refund clawbacks, net, and
  the amount paid. Totals in different currencies are never added together.
  A payout is in one currency, but rows booked before currencies were
  normalised (`inr` and `INR`) are the same currency and total together. In
  a currency paid in whole units (JPY), the amount paid is the net rounded,
  and the statement says so.
- **Notes.** A `pending` manual payout says the brand hasn't confirmed
  sending it, and a reversed one says so. A `failed` payout says it paid
  nothing only when that's known: a Connect payout the partner couldn't
  receive (it says why), or a transfer intent that was cancelled with its
  commissions released. Any other failed payout (a transfer under duplicate
  review, or reversed before it was recorded) may have moved money, so its
  statement promises nothing and points the partner to the brand.

Amounts are formatted in each currency's own conventions (`₹1,25,000.50`,
`$1,234.50`, `¥1,001`). Dates are YYYY-MM-DD in UTC.

## Opening one

| Who | How |
|---|---|
| Brand admin | Payouts page: the **Statement → View** link on every row, in the list of all payouts and in one partner's history |
| Partner | Payouts page in the partner portal: the same link on each of their payouts |
| Integration | `GET /payouts/{id}/statement` with an admin key or a key holding `payouts:read` |

A partner (session or partner key) gets only their own payouts' statements.
Another partner's payout answers `404 payout_not_found`, exactly like a
payout that doesn't exist. A scoped key without `payouts:read` gets
`403 forbidden_scope`. Partners can't read or change the statement
settings.

`GET /payouts/{id}/statement` returns the printable page by default.
`?format=json` returns the same content as data (`PayoutStatement` in the
OpenAPI spec), for a headless program that shows statements in its own app
or files them in an accounting system. Both are sent `Cache-Control:
private, no-store`. The page is self-contained: inline CSS, no scripts, the
logo as its only image, and a Content-Security-Policy that allows nothing
else.

The `payout.created` webhook carries `statementUrl`: the statement's address
on the brand's API (`https://<portal>/api/t/<slug>/payouts/<id>/statement`,
or `https://<custom domain>/api/...`). Fetch it with an API key like any
other call.

### PDF

There is no server-side PDF. Print the page and choose **Save as PDF**; the
page has print styles for A4. A server-side PDF needs either a headless
browser (a large dependency to run on every API instance) or a PDF library
with a Unicode font bundled into the image. PDF's built-in fonts can't print
`₹` or a name in Devanagari or Tamil script, and complex scripts need text
shaping that the lightweight libraries don't do. The browser already gets
all of that right with the reader's own fonts.

### All of a run's statements

Not built yet. A run can hold thousands of payouts for a headless program,
so a single document or zip of all of them needs paging or a background job
and somewhere to store the result. Until then, an integration can page
through `GET /payouts` and fetch each statement as JSON.

## Brand settings

Config key `payout_statements` (portable: it travels in the export bundle,
docs/data-portability.md). Admin → Settings → **Payout statements**, or
`GET` / `POST /config/payout-statements` with an admin key.

| Field | Prints as |
|---|---|
| `legalName` | the name the statement is issued in. Empty: the program name. When it differs from the program name, the program name prints under it. |
| `address` | under the name, line breaks kept |
| `footer` | at the foot of every statement, line breaks kept |
| `numberPrefix` | before the payout id, making the statement number (`PS-01J…`). Letters, digits and `/ _ . # -`, up to 20 characters |
| `taxLines` | `{ enabled, labels }`, off by default; see below. API only, not on the Settings page |

A `POST` changes only the fields it sends; `""` or `null` clears one.

The statement number is the prefix plus the payout id: unique, and the same
every time the statement is printed. It is not a consecutive serial number.

## Tax

OpenPartner doesn't calculate, withhold or report tax. Whether a brand needs
a GST tax invoice, tax deducted at source (TDS) shown, or anything else is
for **the brand's accountant** to say; this feature makes no assumption
either way.

`taxLines` is a placeholder for when they have. Turned on, each label
(default `Tax withheld`) prints as a row in a Tax section marked **Not
recorded**, with a note saying a line with no amount has none recorded.
Nothing records a tax amount yet, so it is off by default and isn't on the
Settings page.

What the answers would mean for the product:

- **TDS on commission.** If the brand must deduct tax before paying, the
  partner receives the commission less the tax. That changes the payout
  amount itself, so it belongs in the payout run (and the batch files), not
  only on the statement.
- **A GST tax invoice.** A tax invoice has its own required contents, among
  them a serial number that runs consecutively within a financial year. A
  payout id isn't one, so this would need a numbering sequence per brand. It
  may also be the partner, as the supplier of the service, who has to issue
  the invoice rather than the brand.

## Not yet

- A bundle (zip or one document) of every statement in a run.
- Recording a reference for a payout sent one at a time (a bank UTR, a UPI
  transaction id) when confirming it, so the statement can print it.
- Recording tax amounts for the tax lines.
