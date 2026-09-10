import Link from 'next/link'
import {auth, signOut} from '@/auth'
import {NavLinks} from '@/components/nav-links'
import {Mark} from '@/components/mark'
import {MainRegion} from '@/components/page-head'

async function AppTopbar() {
  const session = await auth()
  if (!session || !session.user) return null

  return (
    <header className="inset-safe-top bg-bg">
      <div className="flex h-14 w-full items-center gap-4 px-4 sm:px-6">
        <Link
          href="/"
          className="flex shrink-0 items-center gap-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          <Mark className="h-[18px] w-[18px] text-accent" />
          <span className="font-mono text-[0.8125rem] font-bold uppercase tracking-[0.14em]">
            StudyBuddy
          </span>
        </Link>

        <NavLinks />

        <form
          className="shrink-0"
          action={async () => {
            'use server'
            await signOut({redirectTo: '/signin'})
          }}
        >
          <button
            type="submit"
            className="rounded-sm px-3 py-1.5 text-sm font-medium hover:text-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            Sign out
          </button>
        </form>
      </div>
    </header>
  )
}

export default async function AppLayout({children}: {children: React.ReactNode}) {
  return (
    <>
      <AppTopbar />
      <MainRegion>{children}</MainRegion>
    </>
  )
}
