import postgres from 'postgres'

export function connect(url: string) {
  return postgres(url, {
    max: 1,
    prepare: false,
    ssl: isLocalDatabaseUrl(url) ? false : 'require',
  })
}

const LOOPBACK_HOSTNAMES = new Set(['localhost', '::1', '[::1]'])

function isLocalDatabaseUrl(url: string): boolean {
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

  const pgHost = process.env.PGHOST?.trim()
  if (!pgHost) return true

  if (pgHost.startsWith('/')) return true

  return isLoopback(pgHost.toLowerCase())
}

function isLoopback(hostname: string): boolean {
  if (LOOPBACK_HOSTNAMES.has(hostname)) return true

  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)
}
