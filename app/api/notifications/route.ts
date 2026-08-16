import { NextResponse } from 'next/server'

import { auth } from '@/auth'
import { db } from '@/lib/db'
import { listNotifications, markAllRead } from '@/lib/notifications'

/** The bell's contents. Polled by the topbar, so deliberately small. */
export async function GET() {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { rows, unread } = await listNotifications(db, session.user.id)

  return NextResponse.json({
    unread,
    notifications: rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      title: row.title,
      body: row.body,
      href: row.href,
      read: row.readAt !== null,
      createdAt: row.createdAt,
    })),
  })
}

/**
 * Mark everything read, which is what opening the bell means.
 *
 * All at once rather than per row: the bell shows the whole list, so opening it
 * is the student seeing them. A per-row endpoint would be a more precise answer
 * to a question nobody is asking.
 */
export async function POST() {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  await markAllRead(db, session.user.id)

  return NextResponse.json({ ok: true })
}
