export function clientIp(headers: Headers): string | null {
  const forwarded = headers.get('x-forwarded-for')?.split(',')[0]?.trim()
  if (forwarded) return forwarded
  return headers.get('x-real-ip')?.trim() || null
}

export function callerIp(headers: Headers): string {
  return clientIp(headers) ?? 'unknown'
}
