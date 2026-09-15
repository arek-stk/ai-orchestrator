import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'packages/*/src/**/*.test.ts',
      'apps/server/src/**/*.test.ts',
      '.github/scripts/**/*.test.mjs',
      '.github/scripts/milestone-release/**/*.test.ts',
    ],
    environment: 'node',
    testTimeout: 30_000,
    // Suites start embedded PGlite databases and containers in beforeAll; under parallel load that can exceed the
    // 10 s default.
    hookTimeout: 30_000,
  },
});
