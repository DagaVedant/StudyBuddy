import Link from 'next/link'

import { auth, signOut } from '@/auth'

import NavLinks from './nav-links'
import ThemeToggle from './theme-toggle'

/**
 * Persistent left navigation. Collapses to a horizontal bar under `lg` so the
 * phone layout keeps full width for page images.
 */
export default async function AppSidebar() {
  const session = await auth()
  if (!session?.user) return null

  return (
    <aside className="border-b border-border lg:h-dvh lg:w-56 lg:shrink-0 lg:border-b-0 lg:border-r">
      <div className="flex items-center gap-3 px-4 py-3 lg:h-full lg:flex-col lg:items-stretch lg:px-3 lg:py-4">
        <Link
          href="/dashboard"
          className="shrink-0 rounded px-1 font-semibold tracking-tight focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent lg:mb-4 lg:px-2 lg:text-lg"
        >
          StudyBuddy
        </Link>

        <NavLinks isAdmin={session.user.role === 'admin'} />

        <div className="flex shrink-0 items-center gap-3 lg:mt-auto lg:justify-between lg:px-2">
          <ThemeToggle />
          <form
            action={async () => {
              'use server'
              await signOut({ redirectTo: '/signin' })
            }}
          >
            <button
              type="submit"
              className="rounded px-1 text-sm text-muted underline underline-offset-2 hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              Sign out
            </button>
          </form>
        </div>
      </div>
    </aside>
  )
}
