import { startDatabase, stopDatabase } from './database'

export default async function globalSetup() {
  await startDatabase()
  return async () => {
    await stopDatabase()
  }
}
