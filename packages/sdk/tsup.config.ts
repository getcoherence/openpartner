import { defineConfig } from 'tsup';
import { globalBuild } from './tsup.global.config.js';

export default defineConfig([
  {
    entry: {
      browser: 'src/browser.ts',
      server: 'src/server.ts',
    },
    format: ['esm', 'cjs'],
    // tsup's declaration build sets `baseUrl`, which TypeScript 6 rejects
    // (TS5101) unless the deprecation is acknowledged.
    dts: { compilerOptions: { ignoreDeprecations: '6.0' } },
    sourcemap: true,
    clean: true,
    // We ship both ESM (modern bundlers) and CJS (older Node). Target ES2020
    // so named imports from /server work under Node 18+ and esbuild tooling
    // don't complain about optional chaining, nullish coalescing, etc.
    target: 'es2020',
    // SDK is tiny and has zero runtime deps; bundling keeps the wire size
    // low even if an older build tool doesn't tree-shake perfectly.
    splitting: false,
  },
  globalBuild,
]);
