import { eq } from 'drizzle-orm'
import { NextResponse } from 'next/server'
import { z } from 'zod'

import { auth, signOut } from '@/auth'
import { deleteAccount } from '@/lib/account/delete'
import { db } from '@/lib/db'
import { users } from '@/lib/db/schema'

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

  await signOut({ redirect: false })

  return NextResponse.json({ ok: true, imagesFailed })
}
