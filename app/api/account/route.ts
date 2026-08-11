import { eq } from 'drizzle-orm'
import { NextResponse } from 'next/server'
import { z } from 'zod'

import { auth, signOut } from '@/auth'
import { deleteAccount } from '@/lib/account/delete'
import { db } from '@/lib/db'
import { users } from '@/lib/db/schema'

/**
 * The typed confirmation. Not a checkbox and not a second button.
 *
 * This is the one irreversible action in the product: it takes every worksheet,
 * every answer, and a spaced-repetition schedule that may represent months. A
 * control that can be triggered by two taps in the wrong place is the wrong
 * shape for that, so the account's own email address has to be typed out.
 */
const schema = z.object({ email: z.string().min(1) })

export async function DELETE(request: Request) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const parsed = schema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
  }

  // Read from the database rather than from the session. The session is a JWT
  // the client holds; the address it has to match is the one the row carries.
  const [account] = await db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, session.user.id))
    .limit(1)

  if (!account) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  if (
    parsed.data.email.trim().toLowerCase() !== (account.email ?? '').toLowerCase()
  ) {
    return NextResponse.json(
      { error: 'That is not the email on this account.' },
      { status: 400 },
    )
  }

  const { imagesFailed } = await deleteAccount(db, session.user.id)

  // The session cookie outlives the row it points at, and a JWT strategy means
  // nothing on the next request would notice: the app would render for an
  // account that no longer exists until the token expired. `redirect: false`
  // because this is a fetch, not a form post, and the client navigates itself.
  await signOut({ redirect: false })

  return NextResponse.json({ ok: true, imagesFailed })
}
