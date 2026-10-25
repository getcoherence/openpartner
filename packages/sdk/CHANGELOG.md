# Changelog

## 0.3.0

Closes the places where a partner click could go missing in the browser, and
reports clicks that arrive so Admin → Tracking health can show the ones that
don't. No breaking API changes; the one new default behaviour is the landing
report (see Compatibility).

### Added

- **Consent mode.** `consent: 'granted' | 'pending' | 'denied'` in
  `OpenPartner.init()` (script tag: `data-consent="pending"`) and
  `setConsent('granted' | 'denied')`.
  - `'pending'` holds the click from the URL in memory only. Nothing is read
    from or written to storage or cookies, no Stripe link is tagged and no
    request is sent until `setConsent('granted')`, which then works even
    after a single-page app has moved off the landing URL.
  - `'denied'`, at load or later, deletes what an earlier visit stored and
    takes the `client_reference_id` the SDK added back off Stripe Payment
    Links and embeds. A reference you set yourself stays. Safe to call more
    than once.
  - The default is `'granted'`: integrations that don't set it behave as
    before.
- **Landing report.** When a click first arrives from the URL, the SDK posts
  its id once to `POST /attribution/landing` (the page's hostname comes from
  the browser's `Origin` header; nothing else about the visitor is sent).
  Admin → Tracking health compares landings with clicks to show the clicks
  lost between the partner link and your page. Turn it off with
  `reportLanding: false` (script tag: `data-landing="off"`).
- **Server-side referral cookie** in `@openpartner/sdk/server`, for Safari,
  which deletes storage a page's scripts wrote after 7 days without a visit.
  A cookie your own server sets on the landing response isn't capped that way,
  and the browser SDK reads it back.
  - `referralCookieHeader(url, options?)`: the `Set-Cookie` value for a
    request whose URL carries `?cref=`, or `null`.
  - `referralCookieMiddleware(options?)`: Express / Connect middleware that
    sets it, adding to any `Set-Cookie` already queued.
  - `readReferralCookie(cookieHeader, name?)`: the referral off a `Cookie`
    header, for `identify()` from your backend or `client_reference_id` on a
    Checkout Session.

### Changed

- **The referral is read back from the `op_ref` cookie** (or
  `referralCookie.name`) when localStorage is empty: on a second subdomain
  (land on `www.`, sign up on `app.` with `referralCookie.domain` /
  `data-cookie-domain` set), after Safari clears localStorage, or where
  localStorage is blocked. Previously only localStorage and the router's
  `_cref` cookie were read.
- **An `op_ref` cookie that already holds the referral isn't rewritten** from
  script, so one your server set keeps its lifetime in Safari. A new click
  still replaces it.
- **A click from the URL is kept in memory as well,** so the referral cookie,
  Stripe tagging and `identify()` still get it where localStorage throws.
- **`clear()` also expires the referral cookie** and removes the Stripe
  references the SDK added.
- **`onError`'s default log line** is now `[openpartner] request failed` (was
  `identify failed`): it also covers the landing report.

### Compatibility

- The landing report is on by default and needs an OpenPartner API that has
  `POST /attribution/landing` (OpenPartner Cloud, or a self-hosted instance
  from October 24 2026 on). An older API answers 404, and the SDK ignores it:
  only a `click_not_found` from a current API reaches `onError`, because that
  usually means `apiUrl` names another program.
- The script tag an OpenPartner portal serves at `/op.js` is built from this
  source and already behaves this way.

## 0.2.0

Published to npm on October 20 2026: Stripe Payment Link and Pricing Table /
Buy Button linking, the script-tag build, the `op_ref` referral cookie, and the
server SDK (`trackEvent`, `trackConversion`, `identify`).

## 0.1.0

The first published version.
