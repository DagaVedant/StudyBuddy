import { eq } from 'drizzle-orm'
import { NextResponse } from 'next/server'

import { db } from '@/lib/db'
import { verificationTokens } from '@/lib/db/schema'

/**
 * E2E-only: reads the verification token issued for an email through the
 * app's own DB connection. The PGlite instance the test harness stands up
 * only tolerates one live connection, so a second one from the test process
 * itself (direct or over a second socket) corrupts this connection instead.
 */
export async function GET(request: Request) {
  if (process.env.ENABLE_TEST_ENDPOINTS !== 'true') {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const email = new URL(request.url).searchParams.get('email')
  if (!email) {
    return NextResponse.json({ error: 'email required' }, { status: 400 })
  }

  const [row] = await db
    .select({ token: verificationTokens.token })
    .from(verificationTokens)
    .where(eq(verificationTokens.identifier, email))
    .limit(1)

  if (!row) {
    return NextResponse.json({ error: 'No token found' }, { status: 404 })
  }

  return NextResponse.json({ token: row.token })
}
