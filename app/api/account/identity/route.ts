import { NextResponse } from 'next/server'
import { z } from 'zod'

import { auth } from '@/auth'
import { db } from '@/lib/db'
import { saveIdentity } from '@/lib/auth/identity'

const bodySchema = z.object({
  name: z.string().trim().max(80).nullable(),
  username: z.string().trim().max(80).nullable(),
})

/**
 * Saves the display name and username from the profile page.
 *
 * Neither authenticates anything, so unlike email there is no verification
 * step and no account-recovery consequence to a typo: this is closer to the
 * `name` field OAuth already writes than to anything security-sensitive.
 *
 * The checking itself lives in `saveIdentity` (lib/auth/identity.ts), which
 * this only calls: that split is what lets it be tested without a session.
 */
export async function PATCH(request: Request) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
  }

  const result = await saveIdentity(db, session.user.id, parsed.data)

  if (!result.ok) {
    return NextResponse.json({ error: result.reason }, { status: result.status })
  }

  return NextResponse.json({ ok: true, name: result.name, username: result.username })
}
