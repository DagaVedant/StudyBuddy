/**
 * Whether `prebuild`'s call to `migrate()` should actually touch the database.
 *
 * The README provisions exactly one `DATABASE_URL`, entered once in Vercel's
 * env panel with no separate preview database, so a preview
 * build and the production build reach the identical live schema. The first
 * version of this guard keyed on `VERCEL_ENV === 'production'` alone, which
 * protected the one deploy a human actually watches and left every other
 * Vercel build - which is most of them, since preview builds fire on every
 * push - migrating that same shared database unattended: two preview builds
 * finishing together still raced each other through the migration folder,
 * and a branch that never merges still left its migration in front of old
 * production code.
 *
 * `lib/test-endpoints.ts` already treats a preview deployment as no safer
 * than production for handing out admin accounts; a preview build silently
 * writing to the shared production schema is the same category of mistake.
 * So this keys on being a Vercel build at all, not on which one, matching
 * `VERCEL_ENV`'s own three values (`production`, `preview`, `development`
 * for `vercel dev`). A genuinely local build, where the README already tells a
 * new user to run `npm run db:migrate` by hand - carries no `VERCEL_ENV` and
 * keeps migrating from `prebuild`, which is the convenience this exists for.
 */
export interface MigrateEnv {
  VERCEL_ENV?: string
  MIGRATE_ON_BUILD?: string
}

export function shouldSkipBuildMigration(
  // Narrowed to the two variables this reads, the same way
  // `testEndpointsEnabled` is: `NodeJS.ProcessEnv` shares no properties with
  // this shape by name, so passing it through the default keeps every caller
  // from needing its own cast.
  env: MigrateEnv = process.env as MigrateEnv,
): boolean {
  if (!env.VERCEL_ENV) return false
  return env.MIGRATE_ON_BUILD !== '1'
}

/**
 * Whether a missing `DATABASE_URL` should stop the build rather than let it
 * quietly ship an unmigrated environment.
 *
 * The build-time skip below this check exists for a build that was never
 * going to reach a database at all - a fresh local `npm run build` before
 * `.env.local` is set up, or the e2e suite, which points `DATABASE_URL` at a
 * PGlite socket and sets `SKIP_MIGRATIONS` instead of relying on this path.
 * On Vercel there is no such build: every environment is supposed to carry
 * `DATABASE_URL` (README, "Deploy to Vercel"), so a Vercel build missing it is a
 * misconfigured environment - naming, most likely, an env var scoped to
 * Production only in Vercel's panel and left off Preview - not a build with
 * nowhere to migrate to. That should fail loudly rather than deploy code
 * against a schema nobody actually created.
 */
export function missingDatabaseUrlIsFatal(
  env: { VERCEL_ENV?: string } = process.env as { VERCEL_ENV?: string },
): boolean {
  return Boolean(env.VERCEL_ENV)
}
