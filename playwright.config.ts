import { defineConfig, devices } from '@playwright/test'

import { E2E_DATABASE_URL } from './e2e/support/database'
import { TEST_SECRETS } from './e2e/support/test-secrets'

const PORT = 3100
const BASE_URL = `http://localhost:${PORT}`

export default defineConfig({
  testDir: './e2e',
  testMatch: /.*\.spec\.ts/,
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
    command: `npm run build && npx next start --port ${PORT}`,
    url: BASE_URL,
    reuseExistingServer: false,
    timeout: 240_000,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      DATABASE_URL: E2E_DATABASE_URL,
      DATABASE_POOL_MAX: '1',
      DATABASE_IDLE_TIMEOUT: '0',
      DATABASE_MAX_LIFETIME: '0',
      ...TEST_SECRETS,
      ADMIN_EMAILS: 'admin@studybuddy.test,boss@studybuddy.test',
      ENABLE_MOCK_AI: 'true',
      DISABLE_RATE_LIMITS: 'true',
      SKIP_MIGRATIONS: 'true',
      NEXT_PUBLIC_APP_URL: BASE_URL,
      BLOB_READ_WRITE_TOKEN: '',
      ENABLE_TEST_ENDPOINTS: 'true',
    },
  },
})
