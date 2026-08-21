'use client'

import Link from 'next/link'
import { useEffect } from 'react'
import { useFormStatus } from 'react-dom'
import { usePathname, useRouter } from 'next/navigation'
const NAV = [
  { href: '/dashboard', label: 'Dashboard' },
  { href: '/worksheets', label: 'Worksheets' },
  { href: '/review', label: 'Review' },
  { href: '/topics', label: 'Topics' },
  { href: '/settings', label: 'Settings' },
]

export function NavLinks() {
  const pathname = usePathname()

  return (
    <nav aria-label="Main" className="min-w-0 flex-1">
      <ul className="flex flex-wrap items-center gap-1 text-sm md:justify-center">
        {NAV.map((item) => {
          const active =
            pathname === item.href || pathname.startsWith(`${item.href}/`)

          return (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={`block whitespace-nowrap px-3 py-2 font-mono text-[0.6875rem] uppercase tracking-[0.12em] transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
                  active
                    ? 'font-bold text-fg'
                    : 'font-normal text-muted hover:text-fg'
                }`}
              >
                {item.label}
              </Link>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}
function GoogleMark() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 48 48"
      aria-hidden="true"
      focusable="false"
      className="shrink-0"
    >
      <path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
      />
      <path
        fill="#FBBC05"
        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24s.92 7.54 2.56 10.78l7.97-6.19z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
      />
    </svg>
  )
}

export function GoogleButton({ label }: { label: string }) {
  const { pending } = useFormStatus()

  return (
    <button type="submit" className="btn btn-google" aria-busy={pending}>
      <GoogleMark />
      {label}
    </button>
  )
}
const INTERVAL_MS = 60_000

export function AutoRefresh() {
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
