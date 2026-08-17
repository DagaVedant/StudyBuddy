import Link from 'next/link'

import { auth, signOut } from '@/auth'

import Mark from './mark'
import NavLinks from './nav-links'
import NotificationBell from './notification-bell'
import ThemeToggle from './theme-toggle'

export default async function AppTopbar() {
  const session = await auth()
  if (!session?.user) return null

  return (
    <header className="inset-safe-top sticky top-0 z-50 border-b border-border bg-bg">
      <div className="mx-auto flex h-14 w-full max-w-6xl items-center gap-4 px-4 sm:px-6">
        <Link
          href="/dashboard"
          className="flex shrink-0 items-center gap-2 rounded focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          <Mark className="h-[18px] w-[18px] text-accent" />
          <span className="text-[0.9375rem] font-semibold tracking-tight">
            StudyBuddy
          </span>
        </Link>

        <NavLinks isAdmin={session.user.role === 'admin'} />

        <div className="flex shrink-0 items-center gap-2">
          <NotificationBell />
          <ThemeToggle />
          <form
            action={async () => {
              'use server'
              await signOut({ redirectTo: '/signin' })
            }}
          >
            <button
              type="submit"
              className="rounded-xl border border-border px-3 py-1.5 text-sm font-medium transition-colors hover:border-accent hover:text-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              Sign out
            </button>
          </form>
        </div>
      </div>
    </header>
  )
}
