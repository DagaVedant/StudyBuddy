import bcrypt from 'bcryptjs'
import { eq } from 'drizzle-orm'
import { NextResponse } from 'next/server'
import { z } from 'zod'

import { db } from '@/lib/db'
import { accounts, users } from '@/lib/db/schema'

const schema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
})

/**
 * E2E-only: an admin account with its Google link already in place.
 *
 * Admin requires a linked Google account, and signup refuses an admin address
 * outright, so there is no longer any way for a test to reach the console
 * through the UI. Nothing here is a shortcut around the rule being tested: the
 * account gets the Google row that proves the address, which is exactly what
 * the rule asks for. The password is only so the test can sign in without
 * standing up an OAuth round trip.
 */
export async function POST(request: Request) {
  if (process.env.ENABLE_TEST_ENDPOINTS !== 'true') {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const parsed = schema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
  }

  const { email, password } = parsed.data

  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email))
    .limit(1)

  const userId =
    existing?.id ??
    (
      await db
        .insert(users)
        .values({
          email,
          passwordHash: await bcrypt.hash(password, 10),
          emailVerified: new Date(),
          // Set, because a signed-in account with no date of birth is sent to
          // onboarding rather than the dashboard.
          dob: new Date('2000-01-15'),
        })
        .returning({ id: users.id })
    )[0].id

  const [link] = await db
    .select({ userId: accounts.userId })
    .from(accounts)
    .where(eq(accounts.userId, userId))
    .limit(1)

  if (!link) {
    await db.insert(accounts).values({
      userId,
      type: 'oauth',
      provider: 'google',
      providerAccountId: `google-${userId}`,
    })
  }

  return NextResponse.json({ ok: true })
}
