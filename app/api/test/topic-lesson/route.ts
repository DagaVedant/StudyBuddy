import { eq } from 'drizzle-orm'
import { NextResponse } from 'next/server'
import { z } from 'zod'

import { db } from '@/lib/db'
import { topicLessons, topics } from '@/lib/db/schema'
import { testEndpointsEnabled } from '@/lib/test-endpoints'

const schema = z.object({
  slug: z.string().min(1),
  lesson: z
    .object({
      bodyMd: z.string().min(1),
      examples: z
        .array(
          z.object({
            question: z.string(),
            working: z.string(),
            answer: z.string(),
          }),
        )
        .default([]),
      commonErrors: z
        .array(
          z.object({
            mistake: z.string(),
            why: z.string(),
            fix: z.string(),
          }),
        )
        .default([]),
      model: z.string().default('a-test-model'),
    })
    .optional(),
})

export async function POST(request: Request) {
  if (!testEndpointsEnabled()) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const parsed = schema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
  }

  const { slug, lesson } = parsed.data

  const [topic] = await db
    .select({ id: topics.id })
    .from(topics)
    .where(eq(topics.slug, slug))
    .limit(1)

  if (!topic) {
    return NextResponse.json({ error: `No topic ${slug}` }, { status: 404 })
  }

  if (lesson) {
    const { bodyMd, examples, commonErrors, model } = lesson

    await db
      .insert(topicLessons)
      .values({ topicId: topic.id, bodyMd, examples, commonErrors, model })
      .onConflictDoUpdate({
        target: topicLessons.topicId,
        set: { bodyMd, examples, commonErrors, model },
      })
  }

  return NextResponse.json({ topicId: topic.id })
}
