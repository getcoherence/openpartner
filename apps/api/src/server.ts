import 'express-async-errors';
import 'dotenv/config';
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

const app = express();
const PORT = Number(process.env.API_PORT ?? 4100);
const MODE = process.env.OPENPARTNER_MODE ?? 'selfhost';

app.use(helmet());
app.use(cors());
app.use(pinoHttp());

// Stripe webhook must see the raw body for signature verification — mount it
// BEFORE express.json() so its own raw-body parser takes effect.
app.use(stripeWebhookRouter);

app.use(express.json({ limit: '1mb' }));

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'api', mode: MODE });
});

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

app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
  req.log?.error({ err }, 'request_failed');
  res.status(500).json({ error: 'internal_error' });
});

app.listen(PORT, () => {
  console.log(`[api] listening on :${PORT} (mode=${MODE})`);
});
