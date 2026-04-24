import { createApp } from './app.js';

const PORT = Number(process.env.API_PORT ?? 4601);
const MODE = process.env.OPENPARTNER_MODE ?? 'selfhost';

const app = createApp();
app.listen(PORT, () => {
  console.log(`[api] listening on :${PORT} (mode=${MODE})`);
});
