import {NextResponse} from 'next/server'
import {z} from 'zod'

import {auth} from '@/auth'
import {consumeRateLimit, REPORT_LIMIT} from '@/lib/api'
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

  const allowance = await consumeRateLimit(db, REPORT_LIMIT, `user:${session.user.id}`)
  if (!allowance.ok) {
    return NextResponse.json(
      {error: "That's a lot of reports at once. Try again shortly."},
      {status: 429, headers: {'Retry-After': String(allowance.retryAfter)}},
    )
  }

  const parsed = schema.safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json({error: 'Invalid request'}, {status: 400})
  }

  const outcome = await recordReport(db, session.user.id, parsed.data)

  if (!outcome.ok) {
    return NextResponse.json(
      {
        error:
          outcome.reason === 'nothing_to_report'
            ? 'There is no explanation on that question yet.'
            : 'Not found',
      },
      {status: 404},
    )
  }

  return NextResponse.json({ok: true}, {status: 201})
}
