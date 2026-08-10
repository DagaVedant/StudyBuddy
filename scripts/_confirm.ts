import { createInterface } from 'node:readline/promises'

/**
 * The two guards every destructive operator script runs before it writes.
 *
 * Both exist because of the same near miss. `reextract-worksheet.ts test`
 * matched worksheet titles with `ilike '%test%'` across every account, took
 * whichever was newest, and deleted its questions, which cascade to attempts,
 * review cards, explanations, answer choices and topic assignments. Against
 * production that is a stranger's answer history and their entire spaced
 * repetition schedule, destroyed by a command that looked like it was aimed at
 * a worksheet of your own.
 *
 * Neither guard tries to work out whether the operator meant it. They make the
 * target visible and require a deliberate second action, which is the only
 * thing that separates the right worksheet from the wrong one.
 */

const LOOPBACK_HOSTNAMES = new Set(['localhost', '::1', '[::1]'])

/**
 * Whether a connection string points at this machine.
 *
 * Exact hostname matching, not a prefix test: `localhost.example.com` is a
 * perfectly registrable domain and a prefix rule would call it local. Anything
 * that will not parse is treated as remote, so a URL this cannot read fails
 * closed rather than open.
 */
export function isLocalDatabaseUrl(
  url: string,
  // Narrowed to the one variable this reads, so a test can pass `{}` for "no
  // PGHOST" without having to build a whole ProcessEnv. `ProcessEnv` declares
  // an index signature but no PGHOST, so it needs the widening read.
  env: { PGHOST?: string } = process.env as { PGHOST?: string },
): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }

  const hostname = parsed.hostname.toLowerCase()
  if (hostname !== '') return isLoopback(hostname)

  // Everything below is the no-host case, and three separate things land here.

  // A URL that lost its scheme. `db.example.com:5432/app` parses as protocol
  // `db.example.com:` with an empty host, so without this it would read as a
  // socket. Nothing legitimate reaches this function with another scheme.
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    return false
  }

  // An authority that names credentials or a port but no host is malformed,
  // not a socket: `postgres://u:p@:5432/db` was aimed at a server.
  if (parsed.username || parsed.password || parsed.port) return false

  // A genuine socket URL, whose host postgres-js resolves through $PGHOST
  // before falling back to localhost (node_modules/postgres/src/index.js). With
  // PGHOST pointing at Neon, `postgres:///studybuddy` connects to Neon while
  // reading as local, so the verdict belongs to PGHOST when it is set.
  const pgHost = env.PGHOST?.trim()
  if (!pgHost) return true

  // An absolute path is a socket directory, which is on this machine.
  if (pgHost.startsWith('/')) return true

  return isLoopback(pgHost.toLowerCase())
}

function isLoopback(hostname: string): boolean {
  if (LOOPBACK_HOSTNAMES.has(hostname)) return true

  // The whole 127.0.0.0/8 loopback range, not just 127.0.0.1.
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)
}

/** The host alone, for printing. The rest of the URL holds the password. */
export function databaseHost(url: string): string {
  try {
    return new URL(url).host || '(unix socket)'
  } catch {
    return '(unparseable DATABASE_URL)'
  }
}

/**
 * Refuses to continue against a database that is not on this machine.
 *
 * `ALLOW_PROD=1` is the way through, and it is deliberately a second thing to
 * type rather than a flag on the command: the failure this prevents is running
 * a command you have run a hundred times locally without noticing which
 * `.env.local` is loaded.
 */
export function requireLocalDb(): void {
  const url = process.env.DATABASE_URL
  if (!url) {
    throw new Error('DATABASE_URL is not set. Copy .env.example to .env.local first.')
  }

  if (isLocalDatabaseUrl(url) || process.env.ALLOW_PROD === '1') return

  throw new Error(
    `Refusing to write to ${databaseHost(url)}: it is not a local database. ` +
      'Set ALLOW_PROD=1 if you mean it.',
  )
}

/**
 * Prints what is about to be destroyed and waits for the word "yes".
 *
 * `--yes` skips it for a scripted run. A non-interactive shell without that
 * flag aborts rather than blocking on a prompt nobody can answer, which also
 * means a destructive script cannot be left half-run by a CI job.
 */
export async function confirmDestructive(summary: string[]): Promise<void> {
  if (process.argv.includes('--yes')) return

  for (const line of summary) console.log(line)

  if (!process.stdin.isTTY) {
    console.log('\nNot a terminal, so there is nobody to confirm. Re-run with --yes.')
    process.exit(1)
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const answer = await rl.question('\nType "yes" to proceed: ')
  rl.close()

  if (answer.trim() !== 'yes') {
    console.log('Aborted.')
    process.exit(1)
  }
}
