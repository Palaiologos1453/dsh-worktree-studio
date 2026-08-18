import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.spec.{ts,tsx}'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    maxWorkers: 2,
  },
})
