import { eq } from 'drizzle-orm'
import { NextResponse } from 'next/server'
import { z } from 'zod'

import { db } from '@/lib/db'
import { users } from '@/lib/db/schema'
import { testEndpointsEnabled } from '@/lib/test-endpoints'

const schema = z.object({
  email: z.string().email(),
  used: z.number().int().min(0),
})

/**
 * E2E-only: sets trial usage through the app's own DB connection.
 *
 * The suite drives the trial-exhausted paths through this rather than through
 * six real uploads. See `testEndpointsEnabled` for why it is not gated on
 * NODE_ENV.
 */
export async function POST(request: Request) {
  if (!testEndpointsEnabled()) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const parsed = schema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
  }

  const { email, used } = parsed.data

  await db.update(users).set({ trialWorksheetsUsed: used }).where(eq(users.email, email))

  return NextResponse.json({ ok: true })
}
