# Email

OpenPartner sends transactional email for magic-link auth (signup
verification + sign-in). Two transports:

- **dev** (default) — writes the message to the `DevMessage` table in
  Postgres. Admins read it back at `/admin/dev-mailbox` in the portal.
  Good for local dev, CI, and demos without configuring a provider.
- **postmark** — POSTs to `https://api.postmarkapp.com/email` using the
  native `fetch`, no SDK. For production.

## Switching to Postmark

Set these in your environment:

```
MAIL_TRANSPORT=postmark
POSTMARK_SERVER_TOKEN=xxxxx
MAIL_FROM=OpenPartner <no-reply@yourdomain.com>
POSTMARK_MESSAGE_STREAM=outbound    # optional — defaults to "outbound"
PORTAL_URL=https://your-portal.example.com
```

Before it works:

1. Verify your sender domain in Postmark. The address in `MAIL_FROM` must
   match a verified sender signature or domain on the server token you
   use. Postmark returns a 422 otherwise.
2. Pick a **message stream**. The default `outbound` stream is
   transactional and suits magic-link emails. If you've created a
   separate transactional stream, set `POSTMARK_MESSAGE_STREAM` to that
   stream's ID. Don't point magic-link emails at a broadcast stream —
   Postmark will reject them.
3. Make sure `PORTAL_URL` matches the public URL the emailed links
   should resolve to. The API bakes this into every magic link.

## Template

Auth emails are built in `apps/api/src/email-templates.ts`. The HTML
uses inline styles only and renders cleanly in Gmail / Apple Mail /
Outlook. The plain-text fallback carries the same URL.

Postmark stores each message with:

- `Tag` — one of `creator_signup`, `creator_signin`, `vendor_signup`,
  `vendor_signin`. Use the tag to group messages in dashboards.
- `Metadata` — currently carries `purpose` and role-specific identifiers
  (`handle`, `slug`, `vendorId`). Useful for debugging a specific
  failed delivery.

## Observing delivery locally

In dev mode the portal's **Dev mailbox** view (admin-only) shows every
captured message with Open link / Copy buttons. Auto-refreshes every 5s.
Great for clicking through signup flows without any external provider
configured.
