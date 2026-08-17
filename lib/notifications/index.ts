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

export function pushConfigured(): boolean {
  return Boolean(
    process.env.VAPID_PUBLIC_KEY &&
      process.env.VAPID_PRIVATE_KEY &&
      process.env.VAPID_SUBJECT,
  )
}

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

async function pushToUser(db: Db, input: NewNotification): Promise<void> {
  if (!pushConfigured()) return

  const subscriptions = await db
    .select()
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.userId, input.userId))

  if (subscriptions.length === 0) return

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

export async function markAllRead(db: Db, userId: string, now = new Date()): Promise<void> {
  await db
    .update(notifications)
    .set({ readAt: now })
    .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)))
}
