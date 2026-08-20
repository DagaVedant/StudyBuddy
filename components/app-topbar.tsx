import Link from 'next/link'

import { auth, signOut } from '@/auth'

import Mark from './mark'
import NavLinks from './nav-links'
import NotificationBell from './notification-bell'

export default async function AppTopbar() {
  const session = await auth()
  if (!session?.user) return null

  /*
   * The masthead rule is ink-weight rather than a hairline. It is the line
   * that separates the running head from the page, and at 1px in --border it
   * was reading as a shadow rather than as a rule.
   */
  return (
    <header className="inset-safe-top sticky top-0 z-50 bg-bg">
      <div className="mx-auto flex h-14 w-full max-w-6xl items-center gap-4 px-4 sm:px-6">
        {/* The wordmark goes home, the way a masthead does. Dashboard has its
            own nav item a few pixels to the right, so pointing this there too
            spent the most recognisable target on the page on a duplicate. */}
        <Link
          href="/"
          className="flex shrink-0 items-center gap-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          <Mark className="h-[18px] w-[18px] text-accent" />
          <span className="font-mono text-[0.8125rem] font-bold uppercase tracking-[0.14em]">
            StudyBuddy
          </span>
        </Link>

        <NavLinks isAdmin={session.user.role === 'admin'} />

        <div className="flex shrink-0 items-center gap-2">
          <NotificationBell />
          <form
            action={async () => {
              'use server'
              await signOut({ redirectTo: '/signin' })
            }}
          >
            <button
              type="submit"
              className="rounded-sm px-3 py-1.5 text-sm font-medium transition-colors hover:border-accent hover:text-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              Sign out
            </button>
          </form>
        </div>
      </div>
    </header>
  )
}
