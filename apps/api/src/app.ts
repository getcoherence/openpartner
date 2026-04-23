import 'express-async-errors';
import './env.js';
import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import pinoHttp from 'pino-http';

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
import { adminOverviewRouter } from './routes/admin-overview.js';
import { networkVendorsRouter } from './routes/network-vendors.js';
import { networkCreatorsRouter } from './routes/network-creators.js';
import { networkOfferingsRouter } from './routes/network-offerings.js';
import { networkRequestsRouter } from './routes/network-requests.js';

export function createApp(options: { enableLogger?: boolean } = {}) {
  const app = express();
  const MODE = process.env.OPENPARTNER_MODE ?? 'selfhost';

  app.use(helmet());
  app.use(cors());
  if (options.enableLogger !== false) app.use(pinoHttp());

  // Stripe webhook must see the raw body for signature verification — mount it
  // BEFORE express.json() so its own raw-body parser takes effect.
  app.use(stripeWebhookRouter);

  app.use(express.json({ limit: '1mb' }));

  app.get('/health', (_req, res) => {
    res.json({ ok: true, service: 'api', mode: MODE });
  });

  app.use(authRouter);
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
  app.use(networkVendorsRouter);
  app.use(networkCreatorsRouter);
  app.use(networkOfferingsRouter);
  app.use(networkRequestsRouter);

  app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
    req.log?.error({ err }, 'request_failed');
    res.status(500).json({ error: 'internal_error' });
  });

  return app;
}
