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
    <nav aria-label="Main" className="min-w-0 flex-1">
      <ul className="flex gap-1 overflow-x-auto text-sm md:justify-center [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {items.map((item) => {
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
