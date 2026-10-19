import './env.js';
import { serve } from '@hono/node-server';
import { createDb } from '@openpartner/db';
import { createRouterApp } from './app.js';

const PORT = Number(process.env.ROUTER_PORT ?? 4701);

const db = await createDb({ connectionString: process.env.DATABASE_URL! });
const app = createRouterApp(db);

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`[router] listening on :${info.port}`);
});
