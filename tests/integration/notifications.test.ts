import { eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { notifications, pushSubscriptions, worksheets } from '@/lib/db/schema'
import { listNotifications, markAllRead, notify, pushConfigured } from '@/lib/notifications'
import { notifyWorksheet } from '@/lib/notifications/worksheet'

import { asDb, createTestDb, type TestDb } from '../helpers/db'
import { makeUser, makeWorksheet } from '../helpers/factories'

let db: TestDb
let close: () => Promise<void>

beforeAll(async () => {
  const created = await createTestDb()
  db = created.db
  close = created.close
})

afterAll(async () => {
  await close()
})

const client = () => asDb(db)

const vapid = { ...process.env }

afterEach(() => {
  process.env = { ...vapid }
})

/**
 * spec.md:611's completion notifications, which did not exist in any form: no
 * email, no push, no inbox. The queue, the heartbeat and the status UI were all
 * built, and the piece that makes them useful was not, so "safe to close this
 * page" was true and useless.
 */
describe('notify', () => {
  it('records a notification the student will find when they come back', async () => {
    const userId = await makeUser(db)

    await notify(client(), {
      userId,
      kind: 'worksheet_ready',
      title: 'Unit 4 Practice',
      body: 'Your worksheet is read and ready to check.',
      href: '/worksheets/w1/status',
    })

    const { rows, unread } = await listNotifications(client(), userId)

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ kind: 'worksheet_ready', title: 'Unit 4 Practice' })
    expect(unread).toBe(1)
  })

  /**
   * The half that has to work without any setup at all. A local checkout and
   * the e2e suite both have no VAPID keys, and neither should have a completion
   * path that throws.
   */
  it('writes the row even with push unconfigured', async () => {
    delete process.env.VAPID_PUBLIC_KEY
    delete process.env.VAPID_PRIVATE_KEY
    delete process.env.VAPID_SUBJECT

    const userId = await makeUser(db)
    await db.insert(pushSubscriptions).values({
      userId,
      endpoint: 'https://push.example/one',
      p256dh: 'key',
      auth: 'secret',
    })

    expect(pushConfigured()).toBe(false)

    await notify(client(), {
      userId,
      kind: 'worksheet_ready',
      title: 'No Push Here',
      body: 'Still recorded.',
      href: '/dashboard',
    })

    expect((await listNotifications(client(), userId)).rows).toHaveLength(1)
  })

  it('keeps one student’s notifications away from another', async () => {
    const mine = await makeUser(db)
    const theirs = await makeUser(db)

    await notify(client(), {
      userId: mine,
      kind: 'worksheet_ready',
      title: 'Mine',
      body: 'x',
      href: '/dashboard',
    })

    expect((await listNotifications(client(), theirs)).rows).toHaveLength(0)
  })
})

describe('markAllRead', () => {
  it('clears the unread count without losing the rows', async () => {
    const userId = await makeUser(db)

    for (const title of ['One', 'Two']) {
      await notify(client(), {
        userId,
        kind: 'worksheet_ready',
        title,
        body: 'x',
        href: '/dashboard',
      })
    }

    expect((await listNotifications(client(), userId)).unread).toBe(2)

    await markAllRead(client(), userId)
    const after = await listNotifications(client(), userId)

    expect(after.unread).toBe(0)
    expect(after.rows).toHaveLength(2)
  })

  /**
   * `isNull` in the update, so the timestamp records when they were first seen
   * rather than the last time the bell happened to be opened.
   */
  it('does not move the timestamp on an already-read notification', async () => {
    const userId = await makeUser(db)
    await notify(client(), {
      userId,
      kind: 'worksheet_ready',
      title: 'One',
      body: 'x',
      href: '/dashboard',
    })

    const first = new Date('2026-01-01T00:00:00.000Z')
    await markAllRead(client(), userId, first)
    await markAllRead(client(), userId, new Date('2026-06-01T00:00:00.000Z'))

    const [row] = await db
      .select({ readAt: notifications.readAt })
      .from(notifications)
      .where(eq(notifications.userId, userId))

    expect(row.readAt?.toISOString()).toBe(first.toISOString())
  })
})

describe('notifyWorksheet', () => {
  it('names the worksheet, since that is what a student recognises', async () => {
    const userId = await makeUser(db)
    const worksheetId = await makeWorksheet(db, userId)
    await db
      .update(worksheets)
      .set({ title: 'Trigonometry Unit 7' })
      .where(eq(worksheets.id, worksheetId))

    await notifyWorksheet(client(), userId, worksheetId, 'worksheet_ready')

    const [row] = (await listNotifications(client(), userId)).rows

    expect(row.title).toBe('Trigonometry Unit 7')
    // The status page rather than a resolved destination: by the time this is
    // opened the worksheet may have been checked or marked, and that page asks
    // `destination()` at the moment of the click.
    expect(row.href).toBe(`/worksheets/${worksheetId}/status`)
  })

  it('says the trial was not spent when a worksheet fails', async () => {
    const userId = await makeUser(db)
    const worksheetId = await makeWorksheet(db, userId)

    await notifyWorksheet(client(), userId, worksheetId, 'worksheet_failed')

    const [row] = (await listNotifications(client(), userId)).rows

    expect(row.kind).toBe('worksheet_failed')
    expect(row.body).toMatch(/not counted against your trial/)
  })

  /** A worksheet deleted between the job finishing and this running. */
  it('says nothing about a worksheet that has gone', async () => {
    const userId = await makeUser(db)

    await notifyWorksheet(client(), userId, 'no-such-worksheet', 'worksheet_ready')

    expect((await listNotifications(client(), userId)).rows).toHaveLength(0)
  })
})
