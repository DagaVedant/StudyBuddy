import postgres from 'postgres'

import { isLocalDatabaseUrl } from './_confirm'

/**
 * The one connection every operator script opens.
 *
 * Twenty-two scripts wrote out the same `postgres(url, { max: 1, prepare: false })`
 * and two of them added a third option the rest were missing, which is the
 * shape a setting takes when there is nowhere for it to live. Each option here
 * exists for a reason a caller should not have to remember:
 *
 * `prepare: false` because `.env.example` recommends a pooled connection
 * string and prepared statements do not survive one. Two of these scripts,
 * `migrate` and `seed`, are the commands the README tells every new user to
 * run, so getting this wrong greets a first-time reader with an error about
 * prepared statements.
 *
 * `max: 1` because a script is one sequential job. A pool would hold
 * connections open against a database whose whole quota is a handful of them.
 *
 * `ssl` decided from the URL rather than hardcoded. `audit-worksheets` used to
 * pin `'require'`, which cannot reach a local Postgres at all, and local is the
 * only database its repair path is now allowed to write to. Deriving it means
 * the same script works against both without a flag.
 */
export function connect(url: string) {
  return postgres(url, {
    max: 1,
    prepare: false,
    ssl: isLocalDatabaseUrl(url) ? false : 'require',
  })
}

/**
 * The configured database, or an error saying what to do about it.
 *
 * The message names the file to copy, because the audience for it is somebody
 * running `npm run db:migrate` for the first time from a fresh clone.
 */
export function requireDatabaseUrl(): string {
  const url = process.env.DATABASE_URL
  if (!url) {
    throw new Error('DATABASE_URL is not set. Copy .env.example to .env.local first.')
  }
  return url
}

/** {@link connect} against {@link requireDatabaseUrl}, which is the usual case. */
export function openDatabase() {
  return connect(requireDatabaseUrl())
}
