import postgres from 'postgres'

import { isLocalDatabaseUrl } from './_confirm'

export function connect(url: string) {
  return postgres(url, {
    max: 1,
    prepare: false,
    ssl: isLocalDatabaseUrl(url) ? false : 'require',
  })
}

export function requireDatabaseUrl(): string {
  const url = process.env.DATABASE_URL
  if (!url) {
    throw new Error('DATABASE_URL is not set. Copy .env.example to .env.local first.')
  }
  return url
}

export function openDatabase() {
  return connect(requireDatabaseUrl())
}
