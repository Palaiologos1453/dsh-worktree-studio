import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.spec.{ts,tsx}'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Windows runners serialize Git worktree and subprocess fixtures so
    // process startup and metadata writes stay within their test deadlines.
    maxWorkers: process.platform === 'win32' ? 1 : 2,
  },
})
