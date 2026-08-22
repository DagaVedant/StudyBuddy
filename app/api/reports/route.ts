import {NextResponse} from 'next/server'
import {z} from 'zod'

import {auth} from '@/auth'
import {guardRateLimit, REPORT_LIMIT} from '@/lib/api'
import {db} from '@/lib/db'
import {recordReport} from '@/lib/mail'

const schema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('worksheet'),
    worksheetId: z.string().min(1),
    message: z.string().trim().max(2000).optional(),
  }),
  z.object({
    kind: z.literal('explanation'),
    questionId: z.string().min(1),
    message: z.string().trim().max(2000).optional(),
  }),
])

export async function POST(request: Request) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({error: 'Unauthorized'}, {status: 401})
  }

  const limited = await guardRateLimit(
    db,
    REPORT_LIMIT,
    `user:${session.user.id}`,
    "That's a lot of reports at once. Try again shortly.",
  )
  if (limited) return limited

  const parsed = schema.safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json({error: 'Invalid request'}, {status: 400})
  }

  const outcome = await recordReport(db, session.user.id, parsed.data)
  if (!outcome.ok) {
    const error =
      outcome.reason === 'nothing_to_report'
        ? 'There is no explanation on that question yet.'
        : 'Not found'
    return NextResponse.json({error}, {status: 404})
  }

  return NextResponse.json({ok: true}, {status: 201})
}
