import { defineConfig } from 'vitest/config';

// Integration tests share a single Postgres database and truncate
// tables in beforeEach. Running files in parallel causes truncate
// races against each other. Serialize for correctness.
export default defineConfig({
  test: {
    fileParallelism: false,
  },
});
