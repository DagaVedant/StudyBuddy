import { createInterface } from 'node:readline/promises'

const LOOPBACK_HOSTNAMES = new Set(['localhost', '::1', '[::1]'])

export function isLocalDatabaseUrl(
  url: string,
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

  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    return false
  }

  if (parsed.username || parsed.password || parsed.port) return false

  const pgHost = env.PGHOST?.trim()
  if (!pgHost) return true

  if (pgHost.startsWith('/')) return true

  return isLoopback(pgHost.toLowerCase())
}

function isLoopback(hostname: string): boolean {
  if (LOOPBACK_HOSTNAMES.has(hostname)) return true

  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)
}

export function databaseHost(url: string): string {
  try {
    return new URL(url).host || '(unix socket)'
  } catch {
    return '(unparseable DATABASE_URL)'
  }
}

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
