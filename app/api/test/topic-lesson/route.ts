import { eq } from 'drizzle-orm'
import { NextResponse } from 'next/server'
import { z } from 'zod'

import { db } from '@/lib/db'
import { topicLessons, topics } from '@/lib/db/schema'
import { testEndpointsEnabled } from '@/lib/test-endpoints'

const schema = z.object({
  slug: z.string().min(1),

  /**
   * Omit to look the topic up without giving it a lesson.
   *
   * The page is routed by id and a test can only reasonably name a slug, so
   * resolving one is useful on its own: it is the only way to reach a topic
   * that has no lesson, which is the state every topic starts in.
   */
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

/**
 * E2E-only: the lesson for one topic, without a GPU in the loop.
 *
 * The lesson page is the one place on the site that renders model-written
 * prose, and writing that prose takes a local 20B model about a minute per
 * topic. Generating one inside a test would make the suite depend on a GPU
 * and on a model's mood, which is a test of neither the page nor the writer.
 *
 * So the content is fixed here and the test asserts the page's side of the
 * contract: that a body, worked examples and common errors reach the reader,
 * and that the line saying a model wrote this is not quietly dropped.
 *
 * Seeded through a route rather than a second database connection because
 * PGlite tolerates exactly one, and the suite's own connection belongs to the
 * app (e2e/support/database.ts). Returns the topic id because the page is
 * routed by id while a test can only reasonably name a slug.
 */
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

    // One lesson per topic, and a test that runs twice should not be the thing
    // that discovers the unique constraint.
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
