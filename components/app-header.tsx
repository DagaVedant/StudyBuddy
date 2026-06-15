import Link from 'next/link'

import { auth, signOut } from '@/auth'

import ThemeToggle from './theme-toggle'

const NAV = [
  { href: '/dashboard', label: 'Dashboard' },
  { href: '/review', label: 'Review' },
  { href: '/upload', label: 'Upload' },
  { href: '/settings', label: 'Settings' },
]

export default async function AppHeader() {
  const session = await auth()
  if (!session?.user) return null

  return (
    <header className="border-b border-border">
      <div className="mx-auto flex w-full max-w-7xl items-center gap-4 px-4 py-3 sm:px-6">
        <Link
          href="/dashboard"
          className="shrink-0 font-semibold tracking-tight focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          StudyBuddy
        </Link>

        <nav aria-label="Main" className="min-w-0 flex-1">
          <ul className="flex gap-1 overflow-x-auto text-sm">
            {NAV.map((item) => (
              <li key={item.href}>
                <Link
                  href={item.href}
                  className="block rounded px-2 py-1 text-muted hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                >
                  {item.label}
                </Link>
              </li>
            ))}
            {session.user.role === 'admin' && (
              <li>
                <Link
                  href="/admin/topics"
                  className="block rounded px-2 py-1 text-muted hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                >
                  Admin
                </Link>
              </li>
            )}
          </ul>
        </nav>

        <ThemeToggle />

        <form
          action={async () => {
            'use server'
            await signOut({ redirectTo: '/signin' })
          }}
        >
          <button
            type="submit"
            className="shrink-0 rounded px-1 text-sm text-muted underline underline-offset-2 hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            Sign out
          </button>
        </form>
      </div>
    </header>
  )
}
