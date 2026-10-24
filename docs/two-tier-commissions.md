# Two-tier commissions: paying partners for the partners they recruit

A program can pay a partner a share of what the partners they recruited earn. Partner A shares their recruit link, partner B joins through it, and in every program that turns this on, A earns a set percent of each commission B earns there.

- **Two levels, never more.** A earns on B. If B recruits C, B earns on C, but A earns nothing on C. A recruiter commission never produces another one.
- **Off by default, per program.** `Program.recruiterCommissionPercent` is null until a brand sets it (Programs → edit → "Pay partners for the partners they recruit").
- **A share of the recruit's commission, not of the sale.** At 10%, B's $50 commission earns A $5. The recruiter can never earn more than the recruit, and the share is paid on top of B's commission, never out of it.

Code:
- Engine: `apps/api/src/recruiter-commissions.ts`, called from `attributeEvent` in `attribution.ts` after each commission it writes.
- Routes: `GET /partners/:id/recruits` (`routes/recruits.ts`), `recruitedByPartnerId` on `POST /partners` and `PATCH /partners/:id`, `ref` on the join page (`routes/partner-signup.ts`), the program fields on `POST`/`PATCH /programs`.
- Migration: `packages/db/migrations/20261024000000_two_tier_commissions.ts`.
- Portal: the program editor's recruiter field (`pages/AdminPrograms.tsx`), Recruit partners for partners and Recruiting on the admin partner page (`pages/PartnerRecruiting.tsx`), `?ref=` on the join page (`pages/PartnerJoin.tsx`).

## Data

| Table | Column | Meaning |
|---|---|---|
| `Partner` | `recruitedByPartnerId` | Who recruited this partner. Null when nobody did. |
| `Partner` | `recruitedAt` | When the recruitment started. Set exactly when `recruitedByPartnerId` is. |
| `Partner` | `recruitCode` | The partner's own code for their join link (`?ref=`). Minted the first time `GET /partners/:id/recruits` is read while a program pays a share. Unique per tenant. |
| `Program` | `recruiterCommissionPercent` | The recruiter's share, as a percent of the recruit's commission (`10.00`). Above 0, at most 50. Null = off. |
| `Program` | `recruiterCommissionMonths` | How many months after `recruitedAt` the recruiter keeps earning. 1–120; null = no limit. |
| `Commission` | `sourceCommissionId` | Set on a recruiter commission: the recruit's commission it is a share of. |

A recruiter commission is an ordinary `Commission` row:

```jsonc
{
  "partnerId": "<A>",                    // the recruiter
  "attributionId": "<B's attribution>",  // the recruit's sale
  "sourceCommissionId": "<B's commission>",
  "amount": "5.00", "currency": "USD", "status": "accrued",
  "metadata": { "rateType": "recruiter", "recruiter": { "percent": 10, "recruitedPartnerId": "<B>" } }
}
```

It sits on the recruit's attribution on purpose. Everything that works per conversion then handles it with the recruit's own commission, with no special case:

- **Refunds** (`refunds.ts`) walk every commission on the conversion's attributions, so a partial refund cuts both by the same share and a full refund reverses both. The recruiter's replacement keeps `sourceCommissionId`.
- **Fraud review** re-derives a customer's events when a click is unflagged, but only an event whose commissions are all still accrued. The recruiter's share is dropped with the recruit's commission and re-accrued with the one the replay derives. An event with anything approved, paid or reversed on it, a share reversed on its own included, keeps its rows.
- **The platform fee** counts the recruiter commission on the commission side of the conversion. `rateType: "recruiter"` keeps it from deciding the revenue side (`docs/platform-fee.md`).
- **Per-program reporting** books it under the program the recruit earned it in.

The partner equality that used to hold everywhere (a commission's partner is its attribution's partner) no longer does. Queries that sum a partner's *own* earnings off their attributions exclude recruiter rows: the bounty `commissions` metric (`performance-metric.ts`), a referral's earnings (`referrals.ts`), and the conversions API's commission per touch (`conversion-ingest.ts`).

Both new self-references (`Partner.recruitedByPartnerId`, `Commission.sourceCommissionId`) are foreign keys `DEFERRABLE INITIALLY DEFERRED`, so a SQL restore that inserts a table in several chunks can write a recruit before their recruiter. Neither has an `ON DELETE` action: a tenant purge deletes a recruiter and their recruit in one statement, which passes at commit, while deleting a recruiter whose recruit stays is refused.

**Locking.** Approving or reversing a commission (the routes and the holdback sweep) locks the conversion it was earned on first, as `refunds.ts` does. A share's id can sort before its source's, so without that an approval locking source then share could deadlock with a refund locking them in id order. Setting a recruiter locks both partner rows first, so two requests making A and B each other's recruiter can't both pass the cycle check.

## Who earns, and when

When `attributeEvent` writes a commission for partner B on an event in program P, it also writes A's share if all of these hold:

1. P has `recruiterCommissionPercent` set.
2. B has a recruiter (A), and A isn't revoked at that moment.
3. The event is at or after B's `recruitedAt`. Setting a recruiter never pays on sales from before.
4. With `recruiterCommissionMonths` set, the event is within that many months of `recruitedAt` (a month is 30.4375 days, as for `recurringMonths`).
5. The share rounds to at least a cent.

A doesn't need to be granted P. The program's setting decides, and the program's commission terms already decided B's commission.

Only a recruit's commission on an attributed sale pays a share. Bonuses, bounties and recruiter commissions themselves never do.

## Lifecycle

A recruiter commission follows the commission it is a share of.

| What happens to B's commission | What happens to A's share |
|---|---|
| Approved by an admin (`POST /commissions/:id/approve`) or the holdback sweep | Approved in the same transaction, whatever A's own holdback. The recruit's holdback is the refund window of the sale both were earned on. |
| Partially refunded | Cut by the same share (a replacement for the kept amount). |
| Fully refunded | Reversed, or a `refund_clawback` if already paid. |
| Reversed by an admin (`POST /commissions/:id/reverse`) | Reversed too. If already paid, it stays paid and gets a `refund_clawback` for what A holds, with `metadata.cause: "recruit_commission_reversed"`, netted off A's next manual or direct-Connect payout. If a payout is moving it right now, it is left and reported as `heldInTransfer`; reversing the source again once the payout settles finishes it (a paid share gets its clawback then). The cascade is convergent, so another retry records nothing twice. |
| Dropped by fraud review (all still accrued) | Dropped with it, and re-accrued by the replay. |

A recruiter commission is never approved on its own before its source: the review queue disables its Approve button, and `POST /commissions/:id/approve` on one answers `409 source_not_approved` until the recruit's commission is approved or paid. An admin can still reverse one on its own.

## Recruiting

- **Join link.** `GET /partners/:id/recruits` returns `recruitUrl`, the join page with `?ref=<recruitCode>`. The join page sends `ref` with the application; a code naming a partner who isn't revoked makes them the applicant's recruiter, with `recruitedAt` the signup time. An unknown code is ignored, so a stale link never fails a signup. `GET /partner-signup/status?ref=` returns the recruiter's name for "Jane invited you to join".
- **Admin or API.** `recruitedByPartnerId` on `POST /partners`, or `PATCH /partners/:id` to set, change or clear it. `recruitedAt` becomes the time of the change, so a new recruiter earns only from then on and commissions already accrued stay with whoever earned them. A `partners:create` key can't set it (`403 forbidden_scope`): naming a recruiter directs money, like commission terms.
- **Refused:** a partner as their own recruiter (`recruiter_is_partner`, also a CHECK), a revoked recruiter (`recruiter_revoked`), one from another tenant (`recruiter_not_found`), and two partners recruiting each other (`recruiter_cycle`), since each would earn on the other's sales.

## Webhooks and postbacks

A recruiter commission fires the usual `commission.accrued` / `.approved` / `.paid` / `.reversed`, with `partnerId` the recruiter and two extra fields: `sourceCommissionId` and `recruitedPartnerId`. Its `clickId`, `eventId`, `subId` and `eventValue` are the recruit's sale, for the brand.

The recruiter's own postback carries nothing of the recruit's sale: `{click_id}`, `{sub_id}`, `{event_id}`, `{transaction_id}` and `{sale_amount}` stay literal, as a bonus's do. Those are the recruit's tracking data and their customer's transaction, and none matches anything in the recruiter's tracker. `{commission_id}`, `{commission_amount}`, `{currency}`, `{status}`, `{program_id}` and `{event_type}` fill in.

`partner.created` carries `recruitedByPartnerId` when a partner recruited them.

## Payout statements and portal

Statement lines and commission lists read "Recruiter commission: \<recruit\>, invoice paid". A clawback from a reversed source reads "Clawback, recruit's commission reversed". Partners see a Recruit partners page once a program they're granted pays a share (or once they have recruits): their link, the share per program, and each recruit with what they've earned them.

## Export

Export `schemaVersion` 11 carries the new columns (`docs/data-portability.md`). A v1–v10 bundle restores with all of them null.

## Not built

- **Self-referral checks.** Nothing stops one person recruiting their own second account beyond the brand's join-page review and the holdback. A check on shared payout details is the obvious next step.
- **Per-partner recruiter terms.** The share is per program; there is no PartnerCommission override for it.
- **The Network.** Creators on the OpenPartner Network see recruiter commissions in their earnings (the rows pass through), but the Network has no recruit link of its own.
- **More than 200 recruits on one page.** `GET /partners/:id/recruits` lists the newest 200 and counts the rest.
