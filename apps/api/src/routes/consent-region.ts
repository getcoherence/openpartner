import { Router } from 'express';
import { consentRuleFor } from '../consent-region.js';
import { lookupIpCountry } from '../geoip.js';
import { ipRateLimit } from '../middleware/rate-limit.js';

export const consentRegionRouter = Router();

// The SDK addresses this under its apiUrl (/t/<slug>/consent-region). No
// tenant is needed, so that form is answered here too, before
// tenantMiddleware would open a transaction for every page view.
const TENANT_FORM = /^\/(?:api\/)?t\/[a-z0-9-]+(\/consent-region\/?(?:\?.*)?)$/;
consentRegionRouter.use((req, _res, next) => {
  const m = TENANT_FORM.exec(req.url);
  if (m) req.url = m[1]!;
  next();
});

// GET /consent-region: the consent rule for the visitor's country
// (consent-region.ts), for the browser SDK's `consent: 'regional'` mode.
// Called on page load from any site running the SDK, so it's open to any
// origin without credentials (app.ts), reads no cookies, touches no
// database and stores nothing. Not cacheable: the answer is per visitor.
//
// Rate limited generously: it's one call per page view, and a 429 is safe,
// since the SDK treats any failure as opt-in.
consentRegionRouter.get(
  '/consent-region',
  ipRateLimit({ name: 'consent-region', max: 300, windowMs: 60_000 }),
  async (req, res) => {
    const country = await lookupIpCountry(req.ip);
    res.set('Cache-Control', 'private, no-store');
    res.json({ rule: consentRuleFor(country), country });
  },
);
