import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    browser: 'src/browser.ts',
    server: 'src/server.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  // We ship both ESM (modern bundlers) and CJS (older Node). Target ES2020
  // so named imports from /server work under Node 18+ and esbuild tooling
  // don't complain about optional chaining, nullish coalescing, etc.
  target: 'es2020',
  // SDK is tiny and has zero runtime deps; bundling keeps the wire size
  // low even if an older build tool doesn't tree-shake perfectly.
  splitting: false,
});
