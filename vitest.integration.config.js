import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['test/integration/**/*.test.js'],
    testTimeout: 60000,
    hookTimeout: 60000,
  },
});
