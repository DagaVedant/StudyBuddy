export function appBaseUrl(): string {
  const raw = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'
  return stripTrailingSlashes(raw)
}

export function stripTrailingSlashes(url: string): string {
  return url.trim().replace(/\/+$/, '')
}
