import Link from 'next/link'
import {auth, signOut} from '@/auth'
import {BrowserDerivedRunner} from '@/components/client'
import {NavLinks} from '@/components/client'
import {MainRegion, Mark} from '@/components/ui'
import {browserTierEnabled, getCredentialSummary} from '@/lib/ai/resolve'
import {db} from '@/lib/db'

async function AppTopbar() {
  const session = await auth()
  if (!session?.user) return null

  return (
    <header className="inset-safe-top bg-bg">
      <div className="mx-auto flex h-14 w-full max-w-6xl items-center gap-4 px-4 sm:px-6">
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

        <div className="flex shrink-0 items-center gap-2">
          <form
            action={async () => {
              'use server'
              await signOut({redirectTo: '/signin'})
            }}
          >
            <button
              type="submit"
              className="rounded-sm px-3 py-1.5 text-sm font-medium transition-colors hover:text-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              Sign out
            </button>
          </form>
        </div>
      </div>
    </header>
  )
}

export default async function AppLayout({
  children,
}: Readonly<{children: React.ReactNode}>) {
  const session = await auth()

  const runsHere = browserTierEnabled() && session?.user?.id
    ? (await getCredentialSummary(db, session.user.id)).some(
        (row) => row.provider === 'ollama' && row.ollamaBaseUrl,
      )
    : false

  return (
    <>
      <AppTopbar />
      <MainRegion>{children}</MainRegion>
      {runsHere && <BrowserDerivedRunner />}
    </>
  )
}
