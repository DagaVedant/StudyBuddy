'use client'

import { useRouter } from 'next/navigation'
import { useEffect } from 'react'

const INTERVAL_MS = 60_000

/*
 * Keeps every page current without the student having to reach for reload.
 *
 * This is router.refresh(), not location.reload(). The distinction matters:
 * refresh re-requests the route and merges the new Server Component payload,
 * leaving client state alone: a half-typed answer on the review page, an
 * upload in flight, scroll position, an open picker. A hard reload every
 * minute would throw all of that away, which is worse than a stale page.
 *
 * Nothing runs while the tab is hidden; a backgrounded tab that is never
 * looked at should not be billing a server render a minute. Coming back to a
 * tab that sat out one or more ticks refreshes straight away, so what you see
 * on return is current rather than however old the tab was when you left it.
 */
export default function AutoRefresh() {
  const router = useRouter()

  useEffect(() => {
    let last = Date.now()

    const refresh = () => {
      last = Date.now()
      router.refresh()
    }

    const tick = setInterval(() => {
      if (!document.hidden) refresh()
    }, INTERVAL_MS)

    const onVisible = () => {
      if (!document.hidden && Date.now() - last >= INTERVAL_MS) refresh()
    }

    document.addEventListener('visibilitychange', onVisible)

    return () => {
      clearInterval(tick)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [router])

  return null
}
