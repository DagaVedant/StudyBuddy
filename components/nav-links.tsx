'use client'

import Link from 'next/link'
import {usePathname} from 'next/navigation'

const NAV = [
  {href: '/dashboard', label: 'Dashboard'},
  {href: '/worksheets', label: 'Worksheets'},
  {href: '/review', label: 'Review'},
  {href: '/topics', label: 'Topics'},
  {href: '/settings', label: 'Settings'},
]

export function NavLinks() {
  const pathname = usePathname()

  let items = []

  for (let item of NAV) {
    let active = false
    if (pathname === item.href) active = true
    if (pathname.startsWith(item.href + '/')) active = true

    let className =
      'block whitespace-nowrap px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent '

    if (active) {
      className = className + 'font-bold text-fg'
    } else {
      className = className + 'font-normal text-muted hover:text-fg'
    }

    items.push(
      <li key={item.href}>
        <Link
          href={item.href}
          aria-current={active ? 'page' : undefined}
          className={className}
        >
          {item.label}
        </Link>
      </li>,
    )
  }

  return (
    <nav aria-label="Main" className="min-w-0 flex-1">
      <ul className="flex flex-wrap items-center gap-1 text-sm md:justify-center">
        {items}
      </ul>
    </nav>
  )
}
