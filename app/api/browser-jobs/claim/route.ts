import { and, eq } from 'drizzle-orm'
import { NextResponse } from 'next/server'

import { auth } from '@/auth'
import { db } from '@/lib/db'
import { userAiCredentials, worksheets } from '@/lib/db/schema'
import { claimJob, queueDepth } from '@/lib/queue'
import { pagesForJob } from '@/lib/worker/ingest'

export async function POST() {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const userId = session.user.id

  const [credential] = await db
    .select({
      baseUrl: userAiCredentials.ollamaBaseUrl,
      visionModel: userAiCredentials.visionModelName,
      textModel: userAiCredentials.modelName,
    })
    .from(userAiCredentials)
    .where(
      and(eq(userAiCredentials.userId, userId), eq(userAiCredentials.provider, 'ollama')),
    )
    .limit(1)

  if (!credential?.baseUrl) {
    return NextResponse.json({ error: 'No Ollama is configured.' }, { status: 409 })
  }

  const job = await claimJob(db, 'browser', null, new Date(), userId)

  if (!job) {
    return NextResponse.json({ job: null, depth: await queueDepth(db, 'browser') })
  }

  const [worksheet] = await db
    .select({
      title: worksheets.title,
      expectedQuestionCount: worksheets.expectedQuestionCount,
    })
    .from(worksheets)
    .where(eq(worksheets.id, job.worksheetId))
    .limit(1)

  return NextResponse.json({
    job: {
      id: job.id,
      worksheetId: job.worksheetId,
      stage: job.stage,
      attemptCount: job.attemptCount,
      title: worksheet?.title ?? null,
      expectedQuestionCount: worksheet?.expectedQuestionCount ?? null,
      checkpoint: job.checkpoint,
    },
    pages: await pagesForJob(db, job.worksheetId),
    ollama: {
      baseUrl: credential.baseUrl,
      visionModel: credential.visionModel ?? 'qwen2.5vl:7b',
      textModel: credential.textModel ?? 'qwen2.5vl:7b',
    },
  })
}
