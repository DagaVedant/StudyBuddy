import { eq } from 'drizzle-orm'
import Link from 'next/link'
import { redirect } from 'next/navigation'

import { auth, signOut } from '@/auth'
import { db } from '@/lib/db'
import { users } from '@/lib/db/schema'
import { getAccountAccuracy, getOverview, getStudyStreak } from '@/lib/dashboard/queries'

import ProfileClient from './profile-client'

export const metadata = { title: 'Profile · StudyBuddy' }

const MEMBER_SINCE = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' })

export default async function ProfilePage() {
  const session = await auth()
  if (!session?.user?.id) redirect('/signin')

  const userId = session.user.id

  const [account, overview, accuracy, streak] = await Promise.all([
    db
      .select({
        name: users.name,
        username: users.username,
        email: users.email,
        image: users.image,
        createdAt: users.createdAt,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1)
      .then((rows) => rows[0]),
    getOverview(db, userId),
    getAccountAccuracy(db, userId),
    getStudyStreak(db, userId),
  ])

  if (!account) redirect('/signin')

  return (
    <>
      <ProfileClient
        name={account.name}
        username={account.username}
        email={account.email}
        image={account.image}
        // Formatted here rather than on the client: a Date crossing the
        // server boundary is fine, but there is nothing the client needs to
        // recompute this for, and doing it here is one less thing that could
        // render differently between the server pass and the browser's own
        // locale guess.
        memberSince={MEMBER_SINCE.format(account.createdAt)}
        worksheetsUploaded={overview.worksheetsUploaded}
        accuracy={accuracy}
        streak={streak}
      />

      {/*
        Rendered here rather than inside the client component, the same
        reason app-topbar.tsx keeps its own copy: an inline server action has
        to be defined in server code, and passing one down as a prop just to
        avoid two small forms is not a saving.
      */}
      <div className="mx-auto w-full max-w-2xl px-4 pb-8 sm:px-6">
        <section aria-labelledby="account-heading" className="card p-4">
          <h2 id="account-heading" className="text-sm font-medium">
            Account
          </h2>

          <div className="mt-4 flex flex-wrap items-center gap-3">
            <form
              action={async () => {
                'use server'
                await signOut({ redirectTo: '/signin' })
              }}
            >
              <button type="submit" className="btn btn-secondary sm:w-auto sm:px-6">
                Sign out
              </button>
            </form>

            {/* Not duplicated here: Settings already has the one irreversible
                control in the product, typed-address confirmation and all. */}
            <Link href="/settings" className="hint underline underline-offset-2">
              Delete account
            </Link>
          </div>
        </section>
      </div>
    </>
  )
}
