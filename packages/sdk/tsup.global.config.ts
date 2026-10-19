import { defineConfig, type Options } from 'tsup';

/**
 * The script-tag build (src/auto.ts): one self-starting file an OpenPartner
 * portal serves at /op.js. Its own outDir, so the main build's clean can't
 * race it. `pnpm --filter @openpartner/sdk build:global` builds just this
 * (the portal's build does), with no declaration step.
 */
export const globalBuild: Options = {
  entry: { openpartner: 'src/auto.ts' },
  outDir: 'dist-global',
  format: ['iife'],
  outExtension: () => ({ js: '.js' }),
  minify: true,
  sourcemap: false,
  dts: false,
  clean: true,
  target: 'es2017',
  splitting: false,
};

export default defineConfig(globalBuild);
