export interface MigrateEnv {
  VERCEL_ENV?: string
  MIGRATE_ON_BUILD?: string
}

export function shouldSkipBuildMigration(
  env: MigrateEnv = process.env as MigrateEnv,
): boolean {
  if (!env.VERCEL_ENV) return false
  return env.MIGRATE_ON_BUILD !== '1'
}

export function missingDatabaseUrlIsFatal(
  env: { VERCEL_ENV?: string } = process.env as { VERCEL_ENV?: string },
): boolean {
  return Boolean(env.VERCEL_ENV)
}
