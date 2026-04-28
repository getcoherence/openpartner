import 'express-async-errors';
import './env.js';
import express, { type NextFunction, type Request, type Response } from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import helmet from 'helmet';
import pinoHttp from 'pino-http';
import { ulid } from 'ulid';

import { stripeWebhookRouter } from './routes/stripe-webhook.js';
import { identifyRouter } from './routes/identify.js';
import { eventsRouter } from './routes/events.js';
import { partnersRouter } from './routes/partners.js';
import { campaignsRouter } from './routes/campaigns.js';
import { linksRouter } from './routes/links.js';
import { dashboardRouter } from './routes/dashboard.js';
import { apiKeysRouter } from './routes/api-keys.js';
import { connectRouter } from './routes/connect.js';
import { payoutsRouter } from './routes/payouts.js';
import { commissionsRouter } from './routes/commissions.js';
import { exportRouter } from './routes/export.js';
import { billingRouter } from './routes/billing.js';
import { authRouter } from './routes/auth.js';
import { partnerAuthRouter } from './routes/partner-auth.js';
import { adminOverviewRouter } from './routes/admin-overview.js';
import { funnelRouter } from './routes/funnel.js';
import { settingsRouter } from './routes/settings.js';
import { adminsRouter } from './routes/admins.js';
import { installRouter } from './routes/install.js';
import { fraudReviewRouter } from './routes/fraud-review.js';
import { webhooksRouter } from './routes/webhooks.js';
import { metricsRouter } from './routes/metrics.js';
import { signupRouter } from './routes/signup.js';
import { partnerSignupRouter } from './routes/partner-signup.js';
import { networkPartnerRouter } from './routes/network-partner.js';
import { accountDeletionRouter } from './routes/account-deletion.js';
import { creatorPortalRouter } from './routes/creator-portal.js';
import { signinRouter } from './routes/signin.js';
import { sessionHomeRouter } from './routes/session-home.js';
import { platformAuthRouter } from './routes/platform-auth.js';
import { tenantMiddleware } from './tenancy.js';

export function createApp(options: { enableLogger?: boolean } = {}) {
  const app = express();
  const MODE = process.env.OPENPARTNER_MODE ?? 'selfhost';

  // Trust the first proxy hop so req.ip is the client IP, not the load
  // balancer. DO App Platform and Caddy both terminate TLS and forward
  // with X-Forwarded-For. One hop is correct — trusting more would let a
  // client spoof their IP by setting X-Forwarded-For themselves.
  app.set('trust proxy', 1);

  app.use(helmet());
  // CORS: credentials: true so the portal can send the op_session cookie
  // cross-origin in dev (portal on :5673, api on :4601). In prod the
  // portal proxy serves /api same-origin so this is a no-op. We must
  // not fall through to origin:true with credentials — that reflects
  // any requesting origin back in Access-Control-Allow-Origin, turning
  // the browser's session cookie into a CSRF payload. Require an
  // explicit allowlist; error in production if unset.
  const corsOrigins = [
    ...(process.env.PORTAL_URL ? [process.env.PORTAL_URL.replace(/\/$/, '')] : []),
    ...(process.env.CORS_EXTRA_ORIGINS
      ? process.env.CORS_EXTRA_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean)
      : []),
    ...(process.env.NODE_ENV !== 'production'
      ? ['http://localhost:5673', 'http://127.0.0.1:5673']
      : []),
  ];
  if (corsOrigins.length === 0 && process.env.NODE_ENV === 'production') {
    throw new Error('PORTAL_URL must be set in production so CORS has an origin allowlist');
  }
  app.use(
    cors({
      origin: corsOrigins,
      credentials: true,
    }),
  );
  app.use(cookieParser());

  // Request correlation: accept an inbound X-Request-Id for callers that
  // want to correlate across services, generate a ULID otherwise, and
  // echo it back as X-Request-Id so a client can paste it into a support
  // ticket. pino-http picks up req.id automatically.
  app.use((req, res, next) => {
    const inbound = req.header('x-request-id');
    const reqId = inbound && inbound.length <= 128 ? inbound : ulid();
    (req as Request & { id?: string }).id = reqId;
    res.setHeader('X-Request-Id', reqId);
    next();
  });

  if (options.enableLogger !== false) {
    app.use(
      pinoHttp({
        genReqId: (req) => (req as Request & { id?: string }).id ?? ulid(),
      }),
    );
  }

  // Stripe webhook must see the raw body for signature verification — mount it
  // BEFORE express.json() so its own raw-body parser takes effect.
  app.use(stripeWebhookRouter);

  // /import is a full-database bundle; 1 MB caps out around a few
  // hundred Click rows. Give it its own parser before the global one
  // kicks in. Everything else stays at 1 MB so a random public endpoint
  // can't tie up the process with a 500 MB JSON blob.
  app.use('/import', express.json({ limit: '256mb' }));
  app.use(express.json({ limit: '1mb' }));

  app.get('/health', (_req, res) => {
    res.json({ ok: true, service: 'api', mode: MODE });
  });

  // ----- Public, non-tenant routes (mounted BEFORE tenantMiddleware) -----
  // These either run before any tenant exists (install), or are platform-
  // wide (metrics scraped by Prometheus). They use the privileged db
  // directly and are responsible for their own access control.
  app.use(installRouter);
  app.use(signupRouter);
  app.use(signinRouter);
  app.use(sessionHomeRouter);
  app.use(platformAuthRouter);
  app.use(metricsRouter);
  // Creator portal is platform-level (no tenant), proxies to Network.
  // Mount before tenantMiddleware so it's reachable from app.openpartner.dev/*
  // without a /t/<slug>/ prefix.
  app.use(creatorPortalRouter);

  // ----- Tenant scope -----
  // Everything below runs inside a per-request transaction with
  // app.tenant_id set, so RLS scopes every query to the current tenant.
  // In single-tenancy mode, tenantId is always 'default'. In multi-tenancy
  // mode, it's resolved from /t/<slug>/... in the URL.
  app.use(tenantMiddleware);

  app.use(authRouter);
  app.use(partnerAuthRouter);
  app.use(partnerSignupRouter);
  app.use(adminsRouter);
  app.use(settingsRouter);
  app.use(funnelRouter);
  app.use(fraudReviewRouter);
  app.use(webhooksRouter);
  app.use(identifyRouter);
  app.use(eventsRouter);
  app.use(partnersRouter);
  app.use(campaignsRouter);
  app.use(linksRouter);
  app.use(dashboardRouter);
  app.use(apiKeysRouter);
  app.use(connectRouter);
  app.use(payoutsRouter);
  app.use(commissionsRouter);
  app.use(exportRouter);
  app.use(billingRouter);
  app.use(adminOverviewRouter);
  app.use(networkPartnerRouter);
  app.use(accountDeletionRouter);

  app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
    req.log?.error({ err }, 'request_failed');
    // Echo message + stack to stderr so CI logs surface 500s that the
    // test harness would otherwise swallow. Safe — these are
    // unauthenticated server-side error paths; we're logging them
    // anyway via pino when the logger's on.
    console.error(`[500] ${req.method} ${req.url} ${err?.message}\n${err?.stack ?? ''}`);
    res.status(500).json({ error: 'internal_error' });
  });

  return app;
}
