import { and, desc, eq, isNull, sql } from 'drizzle-orm'

import { notifications, pushSubscriptions } from '@/lib/db/schema'
import type { Db } from '@/lib/db/types'

export type NotificationKind = 'worksheet_ready' | 'worksheet_failed'

export interface NewNotification {
  userId: string
  kind: NotificationKind
  title: string
  body: string
  href: string
}

/**
 * Whether push is configured at all.
 *
 * VAPID keys identify this server to the browser's push service. Without them
 * the in-app half still works and the push half is skipped, which is the right
 * shape for a local checkout and for the e2e suite: neither has keys, and
 * neither should have a notification path that throws.
 */
export function pushConfigured(): boolean {
  return Boolean(
    process.env.VAPID_PUBLIC_KEY &&
      process.env.VAPID_PRIVATE_KEY &&
      process.env.VAPID_SUBJECT,
  )
}

/**
 * Record a notification and try to push it.
 *
 * The row is written first and unconditionally. Push is best-effort on top: a
 * student who never granted permission, or whose subscription has expired,
 * still finds this waiting next time they open the app, which is the half that
 * cannot fail. Nothing here throws, because every caller is a job completing
 * and a worksheet that finished must not be reported as failed because a push
 * service was unreachable.
 */
export async function notify(db: Db, input: NewNotification): Promise<void> {
  const [row] = await db
    .insert(notifications)
    .values(input)
    .returning({ id: notifications.id })

  await pushToUser(db, input).catch((error: unknown) => {
    console.warn(
      `[notify] wrote notification ${row?.id} but could not push it:`,
      (error as Error).message,
    )
  })
}

/**
 * Deliver to every browser this student has subscribed, and prune the dead.
 *
 * A 404 or 410 from a push service is that service telling us the subscription
 * is gone for good: the browser was uninstalled, the permission revoked, the
 * profile wiped. Keeping the row means retrying it forever on every completion,
 * so those are deleted. Any other failure is left alone, because a push service
 * having a bad afternoon is not a reason to lose the address.
 */
async function pushToUser(db: Db, input: NewNotification): Promise<void> {
  if (!pushConfigured()) return

  const subscriptions = await db
    .select()
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.userId, input.userId))

  if (subscriptions.length === 0) return

  // Imported here rather than at module scope. `web-push` reaches for Node
  // crypto and http, and this module is imported by code that also runs in
  // route handlers on the edge of what Next will bundle for the client.
  const webpush = (await import('web-push')).default

  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT!,
    process.env.VAPID_PUBLIC_KEY!,
    process.env.VAPID_PRIVATE_KEY!,
  )

  const payload = JSON.stringify({
    title: input.title,
    body: input.body,
    href: input.href,
  })

  await Promise.all(
    subscriptions.map(async (subscription) => {
      try {
        await webpush.sendNotification(
          {
            endpoint: subscription.endpoint,
            keys: { p256dh: subscription.p256dh, auth: subscription.auth },
          },
          payload,
        )
      } catch (error) {
        const status = (error as { statusCode?: number }).statusCode

        if (status === 404 || status === 410) {
          await db
            .delete(pushSubscriptions)
            .where(eq(pushSubscriptions.id, subscription.id))
          return
        }

        console.warn(
          `[notify] push to ${subscription.endpoint.slice(0, 40)}… failed:`,
          (error as Error).message,
        )
      }
    }),
  )
}

/** The bell's contents: newest first, with the unread count beside them. */
export async function listNotifications(db: Db, userId: string, limit = 20) {
  const [rows, [unread]] = await Promise.all([
    db
      .select()
      .from(notifications)
      .where(eq(notifications.userId, userId))
      .orderBy(desc(notifications.createdAt))
      .limit(limit),
    db
      .select({ value: sql<number>`count(*)::int` })
      .from(notifications)
      .where(and(eq(notifications.userId, userId), isNull(notifications.readAt))),
  ])

  return { rows, unread: Number(unread?.value ?? 0) }
}

/**
 * Mark everything this student has as read.
 *
 * All of them rather than one at a time: the bell shows the list, so opening it
 * is the student seeing them. Scoped by user in the statement, and `isNull`
 * keeps the first timestamp rather than moving it every time the bell opens.
 */
export async function markAllRead(db: Db, userId: string, now = new Date()): Promise<void> {
  await db
    .update(notifications)
    .set({ readAt: now })
    .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)))
}
