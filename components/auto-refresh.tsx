'use client'

import { useRouter } from 'next/navigation'
import { useEffect } from 'react'

const INTERVAL_MS = 60_000

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
