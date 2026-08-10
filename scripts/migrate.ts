import { config } from 'dotenv'

config({ path: '.env.local' })

import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'

async function main() {
  // The end-to-end suite points DATABASE_URL at a PGlite socket that is not
  // listening yet when the build runs, and it applies its own migrations
  // anyway. Only the test config sets this, so a deployment cannot skip by
  // accident.
  if (process.env.SKIP_MIGRATIONS === 'true') {
    console.log('SKIP_MIGRATIONS set, not migrating.')
    return
  }

  // Migrating from the build hook is fine everywhere except the one place it
  // matters. On a production deployment it means every build writes to the live
  // schema: two deploys finishing together race each other through the same
  // migration folder, and a rollback puts yesterday's code in front of today's
  // schema, which drizzle has no way to undo. Vercel has no release phase to
  // move this to, so the release step is a person running `npm run db:migrate`
  // before they deploy. MIGRATE_ON_BUILD=1 opts back in.
  const fromBuild = process.argv.includes('--if-configured')

  if (fromBuild && process.env.VERCEL_ENV === 'production' && process.env.MIGRATE_ON_BUILD !== '1') {
    console.log(
      'Production deployment: not migrating from the build.\n' +
        'Run `npm run db:migrate` against production first, then deploy.\n' +
        'Set MIGRATE_ON_BUILD=1 to restore the old behaviour.',
    )
    return
  }

  const url = process.env.DATABASE_URL

  if (!url) {
    // Run straight from the build, where a missing URL means this is a build
    // that was never going to reach a database, so skipping is correct and
    // failing would break it for no reason. Run by hand it is a real mistake
    // and worth stopping for.
    if (fromBuild) {
      console.log('No DATABASE_URL, skipping migrations.')
      return
    }
    throw new Error('DATABASE_URL is not set. Copy .env.example to .env.local first.')
  }

  // prepare: false because .env.example recommends a pooled connection string,
  // against which prepared statements fail, and this is one of the two commands
  // the README tells every new user to run.
  const sql = postgres(url, { max: 1, prepare: false })

  await sql`CREATE EXTENSION IF NOT EXISTS vector`

  await migrate(drizzle(sql), { migrationsFolder: './drizzle' })
  await sql.end()

  console.log('Migrations applied.')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
