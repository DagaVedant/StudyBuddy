import { startDatabase, stopDatabase } from './database'

/**
 * Playwright runs this once before the suite and keeps the returned teardown
 * for afterwards. The socket server has to outlive setup, so the process-level
 * handles in `database.ts` are module state rather than locals.
 */
export default async function globalSetup() {
  await startDatabase()
  return async () => {
    await stopDatabase()
  }
}
