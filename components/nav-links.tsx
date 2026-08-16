'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

/*
 * Five slots became five again, with Topics in place of Profile.
 *
 * Profile and Settings were two top-level slots for one account area, and the
 * less important of them was listed first: Profile holds a display name, a
 * username and an avatar, while Settings holds the AI provider setup, the trial
 * state and account deletion. On mobile these live in a horizontally scrolling
 * strip, so each one costs real estate on the screen size spec.md:343 calls
 * primary. Profile is now reached from Settings, which is where somebody
 * looking for their account already is.
 *
 * The slot went to Topics rather than being left empty. 341 topics had no route
 * in at all except being ranked weak at one, which meant the only way to browse
 * the taxonomy was to fail at part of it.
 */
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
      <ul className="flex gap-1 overflow-x-auto text-sm md:justify-center [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {items.map((item) => {
          const active =
            pathname === item.href || pathname.startsWith(`${item.href}/`)

          return (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={`block whitespace-nowrap rounded-lg px-3 py-1.5 font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
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
