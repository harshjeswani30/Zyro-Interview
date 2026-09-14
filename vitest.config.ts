import { defineConfig } from 'vitest/config'

// Root Vitest config for the Electron app. Scoped to unit-testable pure modules
// under src/ (no Electron/DOM). The separate website/ and ai-gateway/ packages
// carry their own Vitest setups and are excluded here.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    exclude: ['node_modules/**', 'out/**', 'dist/**', 'website/**', 'ai-gateway/**']
  }
})
