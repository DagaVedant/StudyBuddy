import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: { '@': import.meta.dirname },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // The DB harness boots a fresh embedded Postgres per file; give it room.
    testTimeout: 30_000,
    hookTimeout: 60_000,
    pool: 'forks',
  },
})
