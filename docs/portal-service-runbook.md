# Portal: static site → service on App Platform

One-off move of an existing App Platform app's portal from a **static site**
to a **service** built from `apps/portal/Dockerfile`. The point is the
frame-protection headers (`docs/deploy-production.md`, "Portal frame
protection"): a static site can't send response headers, the portal's nginx
can. Apps created from `.do/app.yaml` after October 2026 already run the
portal as a service and don't need this.

About 15 minutes, most of it App Platform building the image. Cost goes up
by one basic-xxs instance: `doctl apps propose` priced the hosted app at
$15 → $20 a month on Oct 23 2026.

## What changes

| | Static site (before) | Service (after) |
| --- | --- | --- |
| Served by | DigitalOcean's CDN from object storage | nginx, 1 × basic-xxs, behind the same CDN |
| Frame headers on HTML | none (the SPA's own check only) | `frame-ancestors 'none'`, `X-Frame-Options: DENY` |
| `index.html` | edge-cached, purged on deploy | `no-cache`: each page load revalidates against nginx |
| `/assets/*` (hashed) | edge-cached | cached a year, `immutable` |
| `/op.js`, favicons | 10 s in browsers, a day at the edge | same |
| SPA routes | `catchall_document` | nginx falls back to `index.html` |

Domains, ingress rules, app-level envs, the api and the router stay exactly as
they are. The script below refuses to write a spec in which domains, ingress or
app envs differ from the live one.

The HTML now comes from one container instead of the CDN. App Platform only
switches to a new deployment once its health check passes, and a failed
deployment leaves the previous one serving.

## 0. Before you start

- This change is merged to `main` and deployed (`doctl apps list-deployments
  "$OP_APP_ID"` shows the merge commit ACTIVE). A static-site build ignores the
  Dockerfile, so the merge alone changes nothing on the hosted app.
- No white-label domain is being added or removed. Steps 1–3 work from a
  snapshot of the live spec, so run them back to back.
- `doctl` is authenticated, and you're in a checkout of `main`.

## 1. Snapshot the live spec and convert it

```bash
doctl apps spec get "$OP_APP_ID" --format json > live.json
node scripts/do-portal-service.mjs to-service live.json > next.json
```

It prints `portal: static site → service. Unchanged: N domain(s), ingress,
app envs, api, router.` Check that N matches the domain list in the console.
Never build the new spec from `.do/app.yaml`: it has no `domains:` block, so
`doctl apps update --spec .do/app.yaml` would drop `app.openpartner.dev` and
every white-label domain.

The spec files hold env values only in DigitalOcean's encrypted `EV[...]` form.
Keep them out of git anyway, and delete them when you're done.

## 2. Dry run

```bash
doctl apps propose --app "$OP_APP_ID" --spec next.json --output json | grep app_cost
```

Expect `"app_cost": 20`; the unchanged spec prices at 15. `propose` validates
the spec on DigitalOcean's side and changes nothing. A 400 here means the spec
is wrong.

## 3. Apply

```bash
doctl apps update "$OP_APP_ID" --spec next.json --update-sources --wait
```

`--update-sources` builds every component from the head of `main`, as a push
deploy does, so the portal image includes the Dockerfile's PostHog build args.
Expect about 5 minutes. If the build or health check fails, the static site
keeps serving: go to [Rollback](#rollback) to put the spec back, otherwise the
next push retries the service.

## 4. Verify

```bash
# Frame headers on the HTML, one of each:
curl -sI https://app.openpartner.dev/t/<slug>/login | grep -iE 'content-security-policy|x-frame-options'
#   content-security-policy: frame-ancestors 'none'
#   x-frame-options: DENY

# The API still sends only helmet's own header (SAMEORIGIN), not a second one:
curl -sI https://app.openpartner.dev/api/health | grep -ic x-frame-options     # 1

# op.js revalidates instead of being pinned for a year:
curl -sI https://app.openpartner.dev/op.js | grep -i cache-control
#   cache-control: public, max-age=10, s-maxage=86400

# The PostHog key reached the build:
JS=$(curl -s https://app.openpartner.dev/ | grep -o 'assets/index-[^"]*\.js' | head -1)
curl -s "https://app.openpartner.dev/$JS" | grep -c phc_                       # 1 or more
```

Then:

- Run the first `curl` against each white-label domain.
- Sign in with a magic link on `app.openpartner.dev`.
- Open a partner link (`/r/<key>`) and check it still redirects.

## Rollback

```bash
doctl apps spec get "$OP_APP_ID" --format json > now.json
node scripts/do-portal-service.mjs to-static now.json > back.json
doctl apps update "$OP_APP_ID" --spec back.json --wait
```

`to-static` puts back the static site that `to-service` replaced, field for
field; a round trip over the live spec matched it exactly on Oct 23 2026.
Export a fresh `now.json` rather than reusing `live.json`, so a domain added in
the meantime survives. The SPA's own frame check protects the portal on either
shape.
