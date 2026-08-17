import { NextResponse } from 'next/server'
import { z } from 'zod'

import { auth } from '@/auth'
import { db } from '@/lib/db'
import { saveIdentity } from '@/lib/auth/identity'

const bodySchema = z.object({
  name: z.string().trim().max(80).nullable(),
  username: z.string().trim().max(80).nullable(),
})

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
