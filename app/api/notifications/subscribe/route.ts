import { and, eq } from 'drizzle-orm'
import { NextResponse } from 'next/server'
import { z } from 'zod'

import { auth } from '@/auth'
import { db } from '@/lib/db'
import { pushSubscriptions } from '@/lib/db/schema'
import { pushConfigured } from '@/lib/notifications'

const subscribeSchema = z.object({
  endpoint: z.string().url().max(1000),
  keys: z.object({
    p256dh: z.string().min(1).max(200),
    auth: z.string().min(1).max(200),
  }),
})

export async function POST(request: Request) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  if (!pushConfigured()) {
    return NextResponse.json(
      { error: 'Push is not configured on this server.' },
      { status: 501 },
    )
  }

  const parsed = subscribeSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid subscription' }, { status: 400 })
  }

  const { endpoint, keys } = parsed.data

  await db
    .insert(pushSubscriptions)
    .values({
      userId: session.user.id,
      endpoint,
      p256dh: keys.p256dh,
      auth: keys.auth,
    })
    .onConflictDoUpdate({
      target: pushSubscriptions.endpoint,
      set: { userId: session.user.id, p256dh: keys.p256dh, auth: keys.auth },
    })

  return NextResponse.json({ ok: true })
}

export async function DELETE(request: Request) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const endpoint = new URL(request.url).searchParams.get('endpoint')
  if (!endpoint) {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
  }

  await db
    .delete(pushSubscriptions)
    .where(
      and(
        eq(pushSubscriptions.endpoint, endpoint),
        eq(pushSubscriptions.userId, session.user.id),
      ),
    )

  return NextResponse.json({ ok: true })
}
