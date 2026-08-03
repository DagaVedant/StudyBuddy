import Link from 'next/link'

import { auth, signOut } from '@/auth'

import NavLinks from './nav-links'
import ThemeToggle from './theme-toggle'

export default async function AppTopbar() {
  const session = await auth()
  if (!session?.user) return null

  return (
    <header className="sticky top-0 z-50 border-b border-border bg-bg">
      <div className="mx-auto flex h-14 w-full max-w-6xl items-center gap-4 px-4 sm:px-6">
        <Link
          href="/dashboard"
          className="flex shrink-0 items-center gap-2 rounded focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          <Mark />
          <span className="text-[0.9375rem] font-semibold tracking-tight">
            StudyBuddy
          </span>
        </Link>

        <NavLinks isAdmin={session.user.role === 'admin'} />

        <div className="flex shrink-0 items-center gap-2">
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

function Mark() {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden="true"
      className="h-[18px] w-[18px] text-accent"
    >
      <rect x="0" y="0" width="7" height="7" rx="1.5" fill="currentColor" />
      <rect x="9" y="0" width="7" height="7" rx="1.5" fill="currentColor" opacity="0.35" />
      <rect x="0" y="9" width="7" height="7" rx="1.5" fill="currentColor" opacity="0.35" />
      <rect x="9" y="9" width="7" height="7" rx="1.5" fill="currentColor" />
    </svg>
  )
}
