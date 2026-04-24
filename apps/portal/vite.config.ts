import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
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
