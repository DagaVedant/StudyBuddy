import { config } from 'dotenv'

config({ path: '.env.local' })

import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { connect } from './db'
import { missingDatabaseUrlIsFatal, shouldSkipBuildMigration } from '../lib/migrate-guard'

async function main() {
  // The end-to-end suite points DATABASE_URL at a PGlite socket that is not
  // listening yet when the build runs, and it applies its own migrations
  // anyway. Only the test config sets this, so a deployment cannot skip by
  // accident.
  if (process.env.SKIP_MIGRATIONS === 'true') {
    console.log('SKIP_MIGRATIONS set, not migrating.')
    return
  }

  // Migrating from the build hook is fine everywhere except a real Vercel
  // deployment, whichever one it is: see lib/migrate-guard.ts for why this
  // covers preview and vercel dev alongside production. Vercel has no release
  // phase to move this to, so the release step is a person running
  // `npm run db:migrate` before they deploy. MIGRATE_ON_BUILD=1 opts back in.
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
      // A real Vercel build with no DATABASE_URL is a misconfigured
      // environment, not a build with nowhere to migrate to - every
      // environment there is supposed to carry it. Only a genuinely local
      // build, with no Vercel env at all, gets the quiet skip: someone
      // running `npm run build` before `cp .env.example .env.local` should
      // not be stopped by a database they have not set up yet.
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

  // prepare: false because .env.example recommends a pooled connection string,
  // against which prepared statements fail, and this is one of the two commands
  // the README tells every new user to run.
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
