'use client'

import {useEffect} from 'react'
import {useRouter} from 'next/navigation'

export function AutoRefresh() {
  const router = useRouter()

  useEffect(() => {
    let last = Date.now()

    function refresh() {
      last = Date.now()
      router.refresh()
    }

    function onTick() {
      if (!document.hidden) refresh()
    }

    function onVisible() {
      if (document.hidden) return
      if (Date.now() - last >= 60000) refresh()
    }

    let timer = setInterval(onTick, 60000)
    document.addEventListener('visibilitychange', onVisible)

    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [router])

  return null
}
