'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

const NAV = [
  { href: '/dashboard', label: 'Dashboard' },
  { href: '/worksheets', label: 'Worksheets' },
  { href: '/review', label: 'Review' },
  { href: '/upload', label: 'Upload' },
  { href: '/settings', label: 'Settings' },
]

export default function NavLinks({ isAdmin }: { isAdmin: boolean }) {
  const pathname = usePathname()

  const items = isAdmin ? [...NAV, { href: '/admin/topics', label: 'Admin' }] : NAV

  return (
    /*
     * Centred on wide screens, scrollable on narrow ones. Scrolling rather
     * than a hamburger keeps every destination one tap away — with six items
     * there is nothing worth hiding behind a menu.
     */
    <nav aria-label="Main" className="min-w-0 flex-1">
      <ul className="flex gap-1 overflow-x-auto text-sm md:justify-center [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {items.map((item) => {
          // Exact match on the index route, prefix match elsewhere, so
          // /worksheets/abc/review still highlights Worksheets.
          const active =
            pathname === item.href || pathname.startsWith(`${item.href}/`)

          return (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={`block whitespace-nowrap rounded px-3 py-1.5 font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
                  active
                    ? 'bg-accent/12 text-accent'
                    : 'text-muted hover:text-fg'
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
