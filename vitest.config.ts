import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.ts'],
  },
  resolve: {
    alias: {
      $: resolve(import.meta.dirname, 'tests/mocks/violentmonkey.ts'),
    },
    extensions: ['.ts', '.js', '.json'],
  },
});
