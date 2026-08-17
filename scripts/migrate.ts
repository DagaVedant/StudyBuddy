import { config } from 'dotenv'

config({ path: '.env.local' })

import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { connect } from './db'
import { missingDatabaseUrlIsFatal, shouldSkipBuildMigration } from '../lib/migrate-guard'

async function main() {
  if (process.env.SKIP_MIGRATIONS === 'true') {
    console.log('SKIP_MIGRATIONS set, not migrating.')
    return
  }

  const fromBuild = process.argv.includes('--if-configured')

  if (fromBuild && shouldSkipBuildMigration()) {
    console.log(
      `Vercel ${process.env.VERCEL_ENV} deployment: not migrating from the build.\n` +
        'Run `npm run db:migrate` against production first, then deploy.\n' +
        'Set MIGRATE_ON_BUILD=1 to restore the old behaviour.',
    )
    return
  }

  const url = process.env.DATABASE_URL

  if (!url) {
    if (fromBuild) {
      if (missingDatabaseUrlIsFatal()) {
        throw new Error(
          `DATABASE_URL is not set on this ${process.env.VERCEL_ENV} deployment. ` +
            'Add it in the Vercel project settings before deploying.',
        )
      }
      console.log('No DATABASE_URL, skipping migrations.')
      return
    }
    throw new Error('DATABASE_URL is not set. Copy .env.example to .env.local first.')
  }

  const sql = connect(url)

  await sql`CREATE EXTENSION IF NOT EXISTS vector`

  await migrate(drizzle(sql), { migrationsFolder: './drizzle' })
  await sql.end()

  console.log('Migrations applied.')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
