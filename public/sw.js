/*
 * The service worker, which exists only to receive push.
 *
 * Deliberately not a caching or offline worker. A service worker is the only
 * thing a browser will deliver a push message to, so this registers to be that
 * and nothing else: it intercepts no fetches, caches no responses and has no
 * opinion about being offline. Adding those would change how every request in
 * the app behaves in exchange for a feature nobody asked for.
 */

self.addEventListener('push', (event) => {
  if (!event.data) return

  let payload
  try {
    payload = event.data.json()
  } catch {
    // A push that is not our JSON is not ours to show. Silently ignored rather
    // than rendered as "[object Object]" on somebody's lock screen.
    return
  }

  const { title, body, href } = payload
  if (!title || !body) return

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      // No `icon` or `badge`. Both take a PNG, this app ships an .ico and an
      // SVG mark, and a notification pointing at a file that is not there is
      // not a fallback: the platform draws its own generic icon either way, so
      // naming a missing one only looks like it works.
      //
      // `tag` coalesces per worksheet, so a retry that pushes twice replaces the
      // first rather than stacking two identical rows in the shade.
      tag: href,
      data: { href },
    }),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()

  const href = event.notification.data?.href ?? '/dashboard'
  const target = new URL(href, self.location.origin).href

  /*
   * Focus a tab that is already here rather than opening a third one.
   *
   * A student who left the app open in a tab and got a push twenty minutes
   * later should land in that tab. `openWindow` unconditionally would give them
   * a second copy of the app, and the one they had open is often the one with
   * the upload screen still on it.
   */
  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((clients) => {
        for (const client of clients) {
          if (new URL(client.url).origin === self.location.origin && 'focus' in client) {
            return client.focus().then((focused) => focused.navigate(target))
          }
        }

        return self.clients.openWindow(target)
      }),
  )
})
