import { request } from '@playwright/test'

import { E2E_BASE_URL } from './app-url'

/**
 * Put the database back to how global setup left it: the canonical taxonomy and
 * nothing else.
 *
 * Call it from `test.beforeAll` at the top of every spec file. Per file, not per
 * test: the serial specs build state across their tests on purpose, and wiping
 * between them would break the thing they are testing. Per file is enough,
 * because what leaks between files is whole accounts, worksheets and reports.
 *
 * This runs over HTTP rather than against PGlite directly. The socket server
 * accepts one connection at a time and the app already holds it, so a second
 * client would be refused.
 */
export async function resetDatabase(): Promise<void> {
  const context = await request.newContext({ baseURL: E2E_BASE_URL })

  try {
    const response = await context.post('/api/test/reset')

    if (!response.ok()) {
      throw new Error(
        `Could not reset the test database (${response.status()}): ${await response.text()}`,
      )
    }

    const { drained } = (await response.json()) as { drained: boolean }

    if (!drained) {
      console.warn(
        '[e2e] a processing job was still running when the database was reset; ' +
          'it may have written rows after the truncate',
      )
    }
  } finally {
    await context.dispose()
  }
}
