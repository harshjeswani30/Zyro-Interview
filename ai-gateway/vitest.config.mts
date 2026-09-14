/**
 * Vitest config for the gateway.
 *
 * The include list is enumerated rather than a `src/**` glob on purpose. There is a
 * pre-existing `src/index.test.ts` that imports `msw`, which is not installed — it is a
 * placeholder from before these modules existed, and pulling it into the run would mean
 * every invocation starts red. Add new suites here explicitly.
 */
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/resume/**/*.test.ts', 'src/vision.test.ts'],
    testTimeout: 20_000
  }
})
