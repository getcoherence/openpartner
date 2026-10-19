import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // `tsc` builds src/__tests__ into dist/__tests__. Vitest 4 no longer
    // excludes dist by default, so keep stale compiled copies out of the run.
    exclude: [...configDefaults.exclude, '**/dist/**'],
  },
});
