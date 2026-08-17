import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: { '@': import.meta.dirname },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    pool: 'forks',
  },
})
