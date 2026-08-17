import Link from 'next/link'

const PAGES = [
  { href: '/admin/topics', label: 'Topic proposals' },
  { href: '/admin/tree', label: 'Canonical tree' },
  { href: '/admin/queue', label: 'Queue' },
  { href: '/admin/usage', label: 'Usage' },
  { href: '/admin/reports', label: 'Reports' },
] as const

export default function AdminNav({ current }: { current: (typeof PAGES)[number]['href'] }) {
  const rest = PAGES.filter((page) => page.href !== current)

  return (
    <>
      {rest.map((page, index) => (
        <span key={page.href}>
          {index > 0 && ' · '}
          <Link href={page.href} className="underline underline-offset-2">
            {page.label}
          </Link>
        </span>
      ))}
      .
    </>
  )
}
