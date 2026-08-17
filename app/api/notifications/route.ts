import { NextResponse } from 'next/server'

import { auth } from '@/auth'
import { db } from '@/lib/db'
import { listNotifications, markAllRead } from '@/lib/notifications'

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

export async function POST() {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  await markAllRead(db, session.user.id)

  return NextResponse.json({ ok: true })
}
