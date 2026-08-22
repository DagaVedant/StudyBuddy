import {NextResponse} from 'next/server'
import {eq} from 'drizzle-orm'
import {z} from 'zod'
import {ACCOUNT_LIMIT, guardRateLimit} from '@/lib/api'
import {auth, signOut} from '@/auth'
import {db} from '@/lib/db'
import {deleteAccount} from '@/lib/auth/identity'
import {users} from '@/lib/schema'

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

  const typed = parsed.data.email.trim().toLowerCase()

  if (typed !== account.email.toLowerCase()) {
    return NextResponse.json(
      {error: 'That is not the email on this account.'},
      {status: 400},
    )
  }

  const {imagesFailed} = await deleteAccount(db, session.user.id)

  await signOut({redirect: false})

  return NextResponse.json({ok: true, imagesFailed})
}

export {deleteRoot as DELETE}
