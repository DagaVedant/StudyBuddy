import { eq } from 'drizzle-orm'
import { NextResponse } from 'next/server'

import { auth } from '@/auth'
import { resolveProvider } from '@/lib/ai/resolve'
import { ProviderRefused, ProviderUnavailable } from '@/lib/ai/types'
import { db } from '@/lib/db'
import { topics } from '@/lib/db/schema'
import { generateLesson, getLesson, type StoredLesson } from '@/lib/topics/lesson'

type Params = { params: Promise<{ topicId: string }> }

function serialize(lesson: StoredLesson) {
  return {
    bodyMd: lesson.bodyMd,
    examples: lesson.examples,
    commonErrors: lesson.commonErrors,
    model: lesson.model,
    // Crosses a JSON boundary, so the Date the DB gives back has to become a
    // string here rather than at every caller.
    generatedAt: lesson.generatedAt.toISOString(),
  }
}

/**
 * Writes the lesson for one topic on demand, from the "Generate lesson
 * overview" button on the topic page.
 *
 * Lessons used to only ever exist if an operator had run
 * `scripts/generate-lessons.ts` by hand, so a topic nobody had pre-generated
 * for simply showed no lesson section at all. This is the student-facing
 * path onto the same `topic_lessons` row.
 *
 * `getLesson` is checked before any provider work, so two clicks or two open
 * tabs do not pay for the model twice. `generateLesson` re-checks the same
 * thing internally (skippable with `force`, which this route never passes),
 * so the check here is not the only guard, just the cheaper, earlier one —
 * belt and braces, not the belt.
 */
export async function POST(_request: Request, { params }: Params) {
  const { topicId } = await params

  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const userId = session.user.id

  const [topic] = await db
    .select({ id: topics.id })
    .from(topics)
    .where(eq(topics.id, topicId))
    .limit(1)

  if (!topic) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const existing = await getLesson(db, topicId)
  if (existing) {
    return NextResponse.json({ lesson: serialize(existing) })
  }

  const { provider, executor } = await resolveProvider(db, userId)

  // Mirrors the same check in app/api/explain/route.ts. A trial account's
  // model lives on the operator's own GPU, which this server cannot call
  // directly; explanations handle that by queuing a job for the worker to
  // collect. Doing the same here would mean a new `job_stage`, which is a
  // real migration with real risk if anything is left half-wired (see the
  // comment above `jobStage` in lib/db/schema.ts) — out of scope for this
  // on-demand button. So instead of queuing, this just asks the student to
  // connect their own provider.
  if (executor === 'operator_gpu' && provider.executionSite === 'none') {
    return NextResponse.json(
      { error: 'Lesson generation needs a connected AI provider. Add one in Settings.' },
      { status: 409 },
    )
  }

  try {
    const generated = await generateLesson(db, provider, topicId)

    // `generateLesson` returns null when it lost a race against another
    // request that wrote the lesson between the `getLesson` check above and
    // this call — not a failure, just somebody else's write landing first.
    // Reading it back returns the same lesson either way.
    const lesson = generated ?? (await getLesson(db, topicId))
    if (!lesson) {
      return NextResponse.json(
        { error: 'Could not generate that lesson. Try again.' },
        { status: 502 },
      )
    }

    return NextResponse.json({ lesson: serialize(lesson) })
  } catch (error) {
    if (error instanceof ProviderUnavailable) {
      return NextResponse.json(
        {
          error:
            'No AI is set up for your account. Add an API key or connect Ollama in settings.',
        },
        { status: 409 },
      )
    }

    if (error instanceof ProviderRefused) {
      return NextResponse.json(
        { error: 'The model declined to write this lesson.' },
        { status: 422 },
      )
    }

    return NextResponse.json(
      { error: 'Could not generate that lesson. Try again.' },
      { status: 502 },
    )
  }
}
