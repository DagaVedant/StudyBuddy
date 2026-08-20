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
      <ul className="flex h-14 items-end gap-1 overflow-x-auto text-sm md:justify-center [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {items.map((item) => {
          const active =
            pathname === item.href || pathname.startsWith(`${item.href}/`)

          return (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={active ? 'page' : undefined}
                /*
                 * Tabs on a filing divider, not tinted pills. The current
                 * page is marked with a pen-weight underline sitting on the
                 * masthead rule, so the indicator reads as a tab sticking
                 * into the page rather than as a selected chip.
                 *
                 * The underline is a transparent border on every item, not
                 * just the active one, so nothing shifts by 2px when the
                 * marker moves between them.
                 */
                className={`-mb-px block whitespace-nowrap border-b-2 px-3 py-2 font-mono text-[0.6875rem] uppercase tracking-[0.12em] transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
                  active
                    ? 'border-pen text-fg'
                    : 'border-transparent text-muted hover:text-fg'
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
