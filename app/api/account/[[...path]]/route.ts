import {NextResponse} from 'next/server'
import {eq} from 'drizzle-orm'
import {z} from 'zod'

import {ACCOUNT_LIMIT, endpoints, guardRateLimit} from '@/lib/api'
import {auth, signOut} from '@/auth'
import {db} from '@/lib/db'
import {deleteAccount, saveIdentity} from '@/lib/auth/identity'
import {users} from '@/lib/schema'

const bodySchema = z.object({
  name: z.string().trim().max(80).nullable(),
  username: z.string().trim().max(80).nullable(),
})

async function patchIdentity(request: Request) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({error: 'Unauthorized'}, {status: 401})
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({error: 'Invalid request'}, {status: 400})
  }

  const limited = await guardRateLimit(
    db,
    ACCOUNT_LIMIT,
    `user:${session.user.id}`,
    'Too many changes to this account. Try again shortly.',
  )
  if (limited) return limited

  const result = await saveIdentity(db, session.user.id, parsed.data)

  if (!result.ok) {
    return NextResponse.json({error: result.reason}, {status: result.status})
  }

  return NextResponse.json({ok: true, name: result.name, username: result.username})
}
const schema = z.object({email: z.string().min(1)})

async function deleteRoot(request: Request) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({error: 'Unauthorized'}, {status: 401})
  }

  const parsed = schema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({error: 'Invalid request'}, {status: 400})
  }

  const limited = await guardRateLimit(
    db,
    ACCOUNT_LIMIT,
    `user:${session.user.id}`,
    'Too many attempts on this account. Try again shortly.',
  )
  if (limited) return limited

  const [account] = await db
    .select({email: users.email})
    .from(users)
    .where(eq(users.id, session.user.id))
    .limit(1)

  if (!account) {
    return NextResponse.json({error: 'Not found'}, {status: 404})
  }

  if (
    parsed.data.email.trim().toLowerCase() !== (account.email ?? '').toLowerCase()
  ) {
    return NextResponse.json(
      {error: 'That is not the email on this account.'},
      {status: 400},
    )
  }

  const {imagesFailed} = await deleteAccount(db, session.user.id)

  await signOut({redirect: false})

  return NextResponse.json({ok: true, imagesFailed})
}

const handle = endpoints([
  ['PATCH', 'identity', patchIdentity],
  ['DELETE', '', deleteRoot],
])

export const GET = handle
export const POST = handle
export const PATCH = handle
export const PUT = handle
export const DELETE = handle
