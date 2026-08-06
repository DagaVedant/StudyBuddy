import { defineConfig, devices } from '@playwright/test'

import { E2E_DATABASE_URL } from './e2e/support/database'

const PORT = 3100
// Auth.js's Server Actions (signIn/signOut) infer the host from request
// headers regardless of what the browser actually navigated to, and that
// inference lands on "localhost" here — so the app is pinned to the same
// host to avoid a same-origin-but-different-cookie-domain mismatch.
const BASE_URL = `http://localhost:${PORT}`

export default defineConfig({
  testDir: './e2e',
  testMatch: /.*\.spec\.ts/,
  // Browser work here is genuinely slow: pdf.js rasterizes and Tesseract
  // downloads a wasm bundle on first use.
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],

  globalSetup: './e2e/support/global-setup.ts',

  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },

  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],

  webServer: {
    // Production build: dev-mode compilation stalls make timing flaky.
    command: `npm run build && npx next start --port ${PORT}`,
    url: BASE_URL,
    reuseExistingServer: false,
    timeout: 240_000,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      DATABASE_URL: E2E_DATABASE_URL,
      // PGlite's socket server serves one connection reliably.
      DATABASE_POOL_MAX: '1',
      // ...and does not survive that one connection being recycled beneath it,
      // so the idle/lifetime recycling that keeps Neon connections fresh is
      // switched off here.
      DATABASE_IDLE_TIMEOUT: '0',
      DATABASE_MAX_LIFETIME: '0',
      AUTH_SECRET: 'e2e-secret-e2e-secret-e2e-secret-abcd=',
      CREDENTIALS_ENC_KEY: Buffer.alloc(32, 7).toString('base64'),
      ADMIN_EMAILS: 'admin@studybuddy.test',
      ENABLE_MOCK_AI: 'true',
      DISABLE_RATE_LIMITS: 'true',
      SKIP_MIGRATIONS: 'true',
      NEXT_PUBLIC_APP_URL: BASE_URL,
      WORKER_API_TOKEN: 'e2e-worker-token',
      BLOB_READ_WRITE_TOKEN: '',
      // Unlocks app/api/test/* — routes the E2E harness reads/writes test
      // state through, since they share the app's own DB connection instead
      // of opening a second one (see e2e/support/database.ts).
      ENABLE_TEST_ENDPOINTS: 'true',
    },
  },
})
