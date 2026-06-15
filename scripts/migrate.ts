import { config } from 'dotenv'

config({ path: '.env.local' })

import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'

async function main() {
  const url = process.env.DATABASE_URL
  if (!url) {
    throw new Error('DATABASE_URL is not set. Copy .env.example to .env.local first.')
  }

  const sql = postgres(url, { max: 1 })

  // 0000_init.sql also does this, but running it here keeps things working if
  // the init migration is ever regenerated without the hand-added header.
  await sql`CREATE EXTENSION IF NOT EXISTS vector`

  await migrate(drizzle(sql), { migrationsFolder: './drizzle' })
  await sql.end()

  console.log('Migrations applied.')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
