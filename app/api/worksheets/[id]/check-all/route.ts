import {NextResponse} from 'next/server'
import {z} from 'zod'
import {unverifyQuestions, verifyRemaining} from '@/lib/questions/queries'
import {guardWorksheet} from '@/lib/queue'
import {guardRateLimit, readJson, WORKSHEET_WRITE_LIMIT} from '@/lib/api'
import {db} from '@/lib/db'

const verifyAllSchema = z.object({
  exclude: z.array(z.string().min(1).max(64)).max(500).optional(),
})

export async function POST(request: Request, {params}: {params: Promise<Record<string, string>>}) {
  const {id: worksheetId} = await params

  const guard = await guardWorksheet(worksheetId)
  if (!guard.ok) {
    return NextResponse.json({error: 'Not found'}, {status: guard.status})
  }

  const parsed = verifyAllSchema.safeParse(await readJson(request))
  if (!parsed.success) {
    return NextResponse.json({error: 'Invalid request'}, {status: 400})
  }

  const limited = await guardRateLimit(
    db,
    WORKSHEET_WRITE_LIMIT,
    'user:' + guard.userId,
    'Too many changes to your worksheets. Try again shortly.',
  )
  if (limited) return limited

  let exclude: string[] = []
  if (parsed.data.exclude) exclude = parsed.data.exclude

  const updated = await verifyRemaining(db, worksheetId, exclude)

  return NextResponse.json({verified: updated.length})
}

const unverifySchema = z.object({ids: z.array(z.string().min(1).max(64)).min(1).max(500)})

export async function DELETE(request: Request, {params}: {params: Promise<Record<string, string>>}) {
  const {id: worksheetId} = await params

  const guard = await guardWorksheet(worksheetId)
  if (!guard.ok) {
    return NextResponse.json({error: 'Not found'}, {status: guard.status})
  }

  const parsed = unverifySchema.safeParse(await readJson(request))
  if (!parsed.success) {
    return NextResponse.json({error: 'Invalid request'}, {status: 400})
  }

  const limited = await guardRateLimit(
    db,
    WORKSHEET_WRITE_LIMIT,
    'user:' + guard.userId,
    'Too many changes to your worksheets. Try again shortly.',
  )
  if (limited) return limited

  const updated = await unverifyQuestions(db, worksheetId, parsed.data.ids)

  return NextResponse.json({unverified: updated.length})
}
