'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

const NAV = [
  { href: '/dashboard', label: 'Dashboard' },
  { href: '/worksheets', label: 'Worksheets' },
  { href: '/review', label: 'Review' },
  { href: '/topics', label: 'Topics' },
  { href: '/settings', label: 'Settings' },
]

export default function NavLinks({ isAdmin }: { isAdmin: boolean }) {
  const pathname = usePathname()

  const items = isAdmin ? [...NAV, { href: '/admin/topics', label: 'Admin' }] : NAV

  return (
    <nav aria-label="Main" className="min-w-0 flex-1">
      <ul className="flex flex-wrap items-center gap-1 text-sm md:justify-center">
        {items.map((item) => {
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
