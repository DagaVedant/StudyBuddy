/**
 * The site's own base URL, without a trailing slash.
 *
 * Whether the deployed value carries one is not something the code gets to
 * decide; it is typed into a hosting dashboard, and both forms look correct
 * there. Joining a path onto it directly produced links like
 * `https://host//verify?token=…`, which reached real inboxes: a path starting
 * with two slashes is not the same route, and a host that redirects to repair
 * it is free to drop the query string on the way, which would take the token
 * with it.
 */
export function appBaseUrl(): string {
  const raw = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'
  return stripTrailingSlashes(raw)
}

export function stripTrailingSlashes(url: string): string {
  return url.trim().replace(/\/+$/, '')
}
