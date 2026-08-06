import { config } from 'dotenv'

config({ path: '.env.local' })

import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'

async function main() {
  const url = process.env.DATABASE_URL

  if (!url) {
    // Run straight from the build, where a missing URL means this is a build
    // that was never going to reach a database, so skipping is correct and
    // failing would break it for no reason. Run by hand it is a real mistake
    // and worth stopping for.
    if (process.argv.includes('--if-configured')) {
      console.log('No DATABASE_URL, skipping migrations.')
      return
    }
    throw new Error('DATABASE_URL is not set. Copy .env.example to .env.local first.')
  }

  const sql = postgres(url, { max: 1 })

  await sql`CREATE EXTENSION IF NOT EXISTS vector`

  await migrate(drizzle(sql), { migrationsFolder: './drizzle' })
  await sql.end()

  console.log('Migrations applied.')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
