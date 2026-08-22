import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // The end-to-end send waits on pg-boss and a real SMTP round trip.
    testTimeout: 45_000,
    hookTimeout: 120_000,
    maxWorkers: 2,
    minWorkers: 1,
    env: { NODE_ENV: 'test', LOG_LEVEL: process.env.LOG_LEVEL ?? 'silent' },
  },
})
