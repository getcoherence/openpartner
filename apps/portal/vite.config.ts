import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Serves the SDK's script-tag build at /op.js: the one tag brands paste so
 * Stripe Payment Links and embeds on their site carry the partner click
 * (Admin → Integrations). The portal's build script builds it first
 * (`pnpm --filter @openpartner/sdk build:global`); this copies it into the
 * static site, and in dev serves it straight from the SDK's output.
 */
function openPartnerScript(): Plugin {
  const source = fileURLToPath(new URL('../../packages/sdk/dist-global/openpartner.js', import.meta.url));
  const missing = 'packages/sdk/dist-global/openpartner.js is missing: run `pnpm --filter @openpartner/sdk build:global`';
  let outDir = 'dist';
  return {
    name: 'openpartner-script',
    configResolved(config) {
      outDir = config.build.outDir;
    },
    configureServer(server) {
      server.middlewares.use('/op.js', (_req, res) => {
        if (!existsSync(source)) {
          res.statusCode = 404;
          res.end(missing);
          return;
        }
        res.setHeader('content-type', 'application/javascript; charset=utf-8');
        res.end(readFileSync(source));
      });
    },
    closeBundle() {
      if (!existsSync(source)) throw new Error(missing);
      copyFileSync(source, `${outDir}/op.js`);
    },
  };
}

export default defineConfig({
  plugins: [react(), openPartnerScript()],
  server: {
    // 5673: stays out of the brightyard-platform 5173/5175 range.
    port: Number(process.env.PORTAL_PORT ?? 5673),
    strictPort: true,
    proxy: {
      '/api': {
        target: process.env.API_URL ?? 'http://localhost:4601',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
});
