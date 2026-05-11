import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['test/**/*.test.js'],
    exclude: ['test/integration/**'],
    // Integration tests boot a local Worker via `wrangler unstable_dev`; allow
    // headroom over the default 5s for startup + multi-WS test paths.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
