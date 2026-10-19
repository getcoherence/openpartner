import { configDefaults, defineConfig } from 'vitest/config';

// Integration tests share a single Postgres database and truncate
// tables in beforeEach. Running files in parallel causes truncate
// races against each other. Serialize for correctness.
export default defineConfig({
  test: {
    // `tsc` builds src/__tests__ into dist/__tests__. Vitest 4 no longer
    // excludes dist by default, so keep stale compiled copies out of the run.
    exclude: [...configDefaults.exclude, '**/dist/**'],
    fileParallelism: false,
    setupFiles: ['src/__tests__/setup-env.ts'],
    // After-hooks in reverse order, so the leak guard setup-env registers
    // checks each file only once the file's own afterAll has cleaned up.
    sequence: { hooks: 'stack' },
  },
});
