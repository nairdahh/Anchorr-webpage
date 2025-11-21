import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['*.js', '!app.js', '!vitest.config.js'],
      exclude: ['node_modules/**', 'test/**', '**/*.test.js'],
    },
  },
});
