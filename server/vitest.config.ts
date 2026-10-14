import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    env: { DB_PATH: ':memory:', CLIENT_URL: '' },
  },
});
