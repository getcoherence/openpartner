import 'express-async-errors';
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import pinoHttp from 'pino-http';

const app = express();
const PORT = Number(process.env.API_PORT ?? 4100);
const MODE = process.env.OPENPARTNER_MODE ?? 'selfhost';

app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(pinoHttp());

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'api', mode: MODE });
});

// TODO(phase-1): mount routes
//   POST /attribution/identify      — snippet posts here on login to stitch click→user
//   POST /attribution/events        — server-to-server conversion events
//   GET  /partners/:id/links        — partner's links
//   POST /partners/:id/links        — create a link
//   GET  /partners/:id/dashboard    — metrics + attributed revenue
//   POST /webhooks/stripe           — consume invoice.paid → emit revenue event

app.listen(PORT, () => {
  console.log(`[api] listening on :${PORT} (mode=${MODE})`);
});
