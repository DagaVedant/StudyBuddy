import { and, eq } from 'drizzle-orm'
import { NextResponse } from 'next/server'
import { z } from 'zod'

import { auth } from '@/auth'
import { db } from '@/lib/db'
import { pushSubscriptions } from '@/lib/db/schema'
import { pushConfigured } from '@/lib/notifications'

/**
 * What `PushSubscription.toJSON()` hands back, narrowed to what we store.
 *
 * The endpoint is a URL at whichever push service the browser uses, so it is
 * bounded generously rather than tightly: they are long, and their shape is the
 * vendor's business rather than ours.
 */
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

  // Refused rather than stored. A subscription saved against a server with no
  // VAPID keys is an address nothing will ever send to, and the client is
  // better off knowing now than finding out by never being notified.
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

  /*
   * Upsert on the endpoint, which is the browser's own identifier for it.
   *
   * Re-subscribing on a device the student already subscribed hands back the
   * same endpoint, so without this every visit would either fail the unique
   * constraint or accumulate rows. `userId` is in the update because an
   * endpoint can legitimately change hands: a shared laptop where somebody else
   * signs in re-subscribes the same browser, and the notifications should
   * follow the person now using it rather than the person who used it last.
   */
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

/** Unsubscribing this browser, which is what turning the toggle off means. */
export async function DELETE(request: Request) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const endpoint = new URL(request.url).searchParams.get('endpoint')
  if (!endpoint) {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
  }

  // Scoped by user as well as endpoint, so naming somebody else's endpoint
  // deletes nothing.
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
