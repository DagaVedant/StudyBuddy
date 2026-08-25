import {and, asc, eq} from 'drizzle-orm'

import {type ExtractedQuestion} from '@/lib/ai/types'
import {type Db} from '@/lib/db'
import {persistQuestions} from '@/lib/worker/pipeline'
import {questions, questionTopics, topics, worksheetPages, worksheets} from '@/lib/schema'

export interface CachedSample {
  slug: string
  title: string
  topicSlug: string
  pages: ExtractedQuestion[][]
}

export const CACHED_SAMPLES: CachedSample[] = [
  {
    slug: 'algebra-25',
    title: 'Algebra practice A',
    topicSlug: 'competition-math.algebra',
    pages: [
      [
        {
          ordinal: 1,
          prompt_text: 'If 3x + 7 = 22, what is the value of x?',
          question_type: 'multiple_choice',
          choices: [{label: 'A', text: '3'}, {label: 'B', text: '5'}, {label: 'C', text: '7'}, {label: 'D', text: '9'}],
          bbox: null,
          has_figure: false,
        },
        {
          ordinal: 2,
          prompt_text: 'What is 15% of 240?',
          question_type: 'multiple_choice',
          choices: [{label: 'A', text: '24'}, {label: 'B', text: '30'}, {label: 'C', text: '36'}, {label: 'D', text: '40'}],
          bbox: null,
          has_figure: false,
        },
        {
          ordinal: 3,
          prompt_text: 'If y = 2x - 4 and x = 6, what is y?',
          question_type: 'multiple_choice',
          choices: [{label: 'A', text: '6'}, {label: 'B', text: '8'}, {label: 'C', text: '10'}, {label: 'D', text: '12'}],
          bbox: null,
          has_figure: false,
        },
        {
          ordinal: 4,
          prompt_text: 'Simplify: 4(2x + 3) - 5x',
          question_type: 'multiple_choice',
          choices: [{label: 'A', text: '3x + 12'}, {label: 'B', text: '3x + 3'}, {label: 'C', text: '13x + 12'}, {label: 'D', text: '8x + 7'}],
          bbox: null,
          has_figure: false,
        },
        {
          ordinal: 5,
          prompt_text: 'What is the slope of the line through (1, 2) and (5, 10)?',
          question_type: 'multiple_choice',
          choices: [{label: 'A', text: '1'}, {label: 'B', text: '2'}, {label: 'C', text: '3'}, {label: 'D', text: '4'}],
          bbox: null,
          has_figure: false,
        },
        {
          ordinal: 6,
          prompt_text: 'Solve for n: n/4 = 9',
          question_type: 'multiple_choice',
          choices: [{label: 'A', text: '13'}, {label: 'B', text: '27'}, {label: 'C', text: '36'}, {label: 'D', text: '45'}],
          bbox: null,
          has_figure: false,
        },
        {
          ordinal: 7,
          prompt_text: 'What is the value of 2^5?',
          question_type: 'multiple_choice',
          choices: [{label: 'A', text: '10'}, {label: 'B', text: '16'}, {label: 'C', text: '25'}, {label: 'D', text: '32'}],
          bbox: null,
          has_figure: false,
        },
        {
          ordinal: 8,
          prompt_text: 'If 5a = 45, what is 2a?',
          question_type: 'multiple_choice',
          choices: [{label: 'A', text: '9'}, {label: 'B', text: '14'}, {label: 'C', text: '18'}, {label: 'D', text: '20'}],
          bbox: null,
          has_figure: false,
        },
        {
          ordinal: 9,
          prompt_text: 'What is the sum of the interior angles of a triangle?',
          question_type: 'multiple_choice',
          choices: [{label: 'A', text: '90'}, {label: 'B', text: '180'}, {label: 'C', text: '270'}, {label: 'D', text: '360'}],
          bbox: null,
          has_figure: false,
        },
        {
          ordinal: 10,
          prompt_text: 'Factor: x^2 - 9',
          question_type: 'multiple_choice',
          choices: [{label: 'A', text: '(x-3)(x-3)'}, {label: 'B', text: '(x+3)(x-3)'}, {label: 'C', text: '(x+9)(x-1)'}, {label: 'D', text: '(x-9)(x+1)'}],
          bbox: null,
          has_figure: false,
        },
        {
          ordinal: 11,
          prompt_text: 'A shirt costs 40 dollars after a 20% discount. What was the original price?',
          question_type: 'multiple_choice',
          choices: [{label: 'A', text: '48'}, {label: 'B', text: '50'}, {label: 'C', text: '52'}, {label: 'D', text: '60'}],
          bbox: null,
          has_figure: false,
        },
        {
          ordinal: 12,
          prompt_text: 'What is the median of 3, 7, 9, 15, 21?',
          question_type: 'multiple_choice',
          choices: [{label: 'A', text: '7'}, {label: 'B', text: '9'}, {label: 'C', text: '11'}, {label: 'D', text: '15'}],
          bbox: null,
          has_figure: false,
        },
        {
          ordinal: 13,
          prompt_text: 'If 2x - 5 = 11, what is x?',
          question_type: 'multiple_choice',
          choices: [{label: 'A', text: '3'}, {label: 'B', text: '6'}, {label: 'C', text: '8'}, {label: 'D', text: '16'}],
          bbox: null,
          has_figure: false,
        },
      ],
      [
        {
          ordinal: 14,
          prompt_text: 'What is the area of a rectangle 7 by 9?',
          question_type: 'multiple_choice',
          choices: [{label: 'A', text: '16'}, {label: 'B', text: '32'}, {label: 'C', text: '63'}, {label: 'D', text: '72'}],
          bbox: null,
          has_figure: false,
        },
        {
          ordinal: 15,
          prompt_text: 'Evaluate: (-3)^2 + 4',
          question_type: 'multiple_choice',
          choices: [{label: 'A', text: '-5'}, {label: 'B', text: '1'}, {label: 'C', text: '13'}, {label: 'D', text: '-13'}],
          bbox: null,
          has_figure: false,
        },
        {
          ordinal: 16,
          prompt_text: 'What is the greatest common factor of 24 and 36?',
          question_type: 'multiple_choice',
          choices: [{label: 'A', text: '4'}, {label: 'B', text: '6'}, {label: 'C', text: '12'}, {label: 'D', text: '18'}],
          bbox: null,
          has_figure: false,
        },
        {
          ordinal: 17,
          prompt_text: 'A car travels 180 miles in 3 hours. What is its average speed?',
          question_type: 'multiple_choice',
          choices: [{label: 'A', text: '50'}, {label: 'B', text: '55'}, {label: 'C', text: '60'}, {label: 'D', text: '65'}],
          bbox: null,
          has_figure: false,
        },
        {
          ordinal: 18,
          prompt_text: 'Solve: x/3 + 2 = 7',
          question_type: 'multiple_choice',
          choices: [{label: 'A', text: '9'}, {label: 'B', text: '12'}, {label: 'C', text: '15'}, {label: 'D', text: '21'}],
          bbox: null,
          has_figure: false,
        },
        {
          ordinal: 19,
          prompt_text: 'What is the perimeter of a square with area 49?',
          question_type: 'multiple_choice',
          choices: [{label: 'A', text: '14'}, {label: 'B', text: '21'}, {label: 'C', text: '28'}, {label: 'D', text: '49'}],
          bbox: null,
          has_figure: false,
        },
        {
          ordinal: 20,
          prompt_text: 'Simplify the ratio 18:24',
          question_type: 'multiple_choice',
          choices: [{label: 'A', text: '2:3'}, {label: 'B', text: '3:4'}, {label: 'C', text: '4:5'}, {label: 'D', text: '6:8'}],
          bbox: null,
          has_figure: false,
        },
        {
          ordinal: 21,
          prompt_text: 'If f(x) = x^2 + 1, what is f(4)?',
          question_type: 'multiple_choice',
          choices: [{label: 'A', text: '9'}, {label: 'B', text: '16'}, {label: 'C', text: '17'}, {label: 'D', text: '25'}],
          bbox: null,
          has_figure: false,
        },
        {
          ordinal: 22,
          prompt_text: 'What is 3/8 as a decimal?',
          question_type: 'multiple_choice',
          choices: [{label: 'A', text: '0.325'}, {label: 'B', text: '0.375'}, {label: 'C', text: '0.38'}, {label: 'D', text: '0.625'}],
          bbox: null,
          has_figure: false,
        },
        {
          ordinal: 23,
          prompt_text: 'The mean of 4, 8, and x is 7. What is x?',
          question_type: 'multiple_choice',
          choices: [{label: 'A', text: '6'}, {label: 'B', text: '9'}, {label: 'C', text: '10'}, {label: 'D', text: '12'}],
          bbox: null,
          has_figure: false,
        },
        {
          ordinal: 24,
          prompt_text: 'Solve: 2(x - 3) = 10',
          question_type: 'multiple_choice',
          choices: [{label: 'A', text: '4'}, {label: 'B', text: '6'}, {label: 'C', text: '8'}, {label: 'D', text: '11'}],
          bbox: null,
          has_figure: false,
        },
        {
          ordinal: 25,
          prompt_text: 'What is the least common multiple of 6 and 8?',
          question_type: 'multiple_choice',
          choices: [{label: 'A', text: '12'}, {label: 'B', text: '24'}, {label: 'C', text: '36'}, {label: 'D', text: '48'}],
          bbox: null,
          has_figure: false,
        },
      ],
    ],
  },
  {
    slug: 'algebra-10',
    title: 'Algebra practice B',
    topicSlug: 'competition-math.algebra',
    pages: [
      [
        {
          ordinal: 1,
          prompt_text: 'If x + 9 = 17, what is x?',
          question_type: 'multiple_choice',
          choices: [{label: 'A', text: '6'}, {label: 'B', text: '8'}, {label: 'C', text: '9'}, {label: 'D', text: '26'}],
          bbox: null,
          has_figure: false,
        },
        {
          ordinal: 2,
          prompt_text: 'What is 25% of 80?',
          question_type: 'multiple_choice',
          choices: [{label: 'A', text: '15'}, {label: 'B', text: '20'}, {label: 'C', text: '25'}, {label: 'D', text: '30'}],
          bbox: null,
          has_figure: false,
        },
        {
          ordinal: 3,
          prompt_text: 'Simplify: 3(x + 4)',
          question_type: 'multiple_choice',
          choices: [{label: 'A', text: '3x + 4'}, {label: 'B', text: '3x + 7'}, {label: 'C', text: '3x + 12'}, {label: 'D', text: 'x + 12'}],
          bbox: null,
          has_figure: false,
        },
        {
          ordinal: 4,
          prompt_text: 'What is the value of 6^2 - 6?',
          question_type: 'multiple_choice',
          choices: [{label: 'A', text: '24'}, {label: 'B', text: '30'}, {label: 'C', text: '36'}, {label: 'D', text: '42'}],
          bbox: null,
          has_figure: false,
        },
        {
          ordinal: 5,
          prompt_text: 'Solve for t: 5t = 60',
          question_type: 'multiple_choice',
          choices: [{label: 'A', text: '10'}, {label: 'B', text: '12'}, {label: 'C', text: '15'}, {label: 'D', text: '20'}],
          bbox: null,
          has_figure: false,
        },
        {
          ordinal: 6,
          prompt_text: 'What is the area of a triangle with base 10 and height 6?',
          question_type: 'multiple_choice',
          choices: [{label: 'A', text: '16'}, {label: 'B', text: '30'}, {label: 'C', text: '60'}, {label: 'D', text: '120'}],
          bbox: null,
          has_figure: false,
        },
        {
          ordinal: 7,
          prompt_text: 'Which number is prime?',
          question_type: 'multiple_choice',
          choices: [{label: 'A', text: '21'}, {label: 'B', text: '27'}, {label: 'C', text: '31'}, {label: 'D', text: '33'}],
          bbox: null,
          has_figure: false,
        },
        {
          ordinal: 8,
          prompt_text: 'If a = 3 and b = -2, what is a - b?',
          question_type: 'multiple_choice',
          choices: [{label: 'A', text: '-5'}, {label: 'B', text: '1'}, {label: 'C', text: '5'}, {label: 'D', text: '6'}],
          bbox: null,
          has_figure: false,
        },
        {
          ordinal: 9,
          prompt_text: 'What is 0.4 written as a fraction in lowest terms?',
          question_type: 'multiple_choice',
          choices: [{label: 'A', text: '1/4'}, {label: 'B', text: '2/5'}, {label: 'C', text: '4/9'}, {label: 'D', text: '40/10'}],
          bbox: null,
          has_figure: false,
        },
        {
          ordinal: 10,
          prompt_text: 'The perimeter of a rectangle is 30 and its width is 5. What is its length?',
          question_type: 'multiple_choice',
          choices: [{label: 'A', text: '5'}, {label: 'B', text: '10'}, {label: 'C', text: '15'}, {label: 'D', text: '20'}],
          bbox: null,
          has_figure: false,
        },
      ],
    ],
  },
  {
    slug: 'algebra-5',
    title: 'Algebra warm-up',
    topicSlug: 'competition-math.arithmetic-and-number-sense',
    pages: [
      [
        {
          ordinal: 1,
          prompt_text: 'What is 7 + 8?',
          question_type: 'multiple_choice',
          choices: [{label: 'A', text: '13'}, {label: 'B', text: '14'}, {label: 'C', text: '15'}, {label: 'D', text: '16'}],
          bbox: null,
          has_figure: false,
        },
        {
          ordinal: 2,
          prompt_text: 'If 2x = 14, what is x?',
          question_type: 'multiple_choice',
          choices: [{label: 'A', text: '5'}, {label: 'B', text: '6'}, {label: 'C', text: '7'}, {label: 'D', text: '12'}],
          bbox: null,
          has_figure: false,
        },
        {
          ordinal: 3,
          prompt_text: 'What is 9 squared?',
          question_type: 'multiple_choice',
          choices: [{label: 'A', text: '18'}, {label: 'B', text: '72'}, {label: 'C', text: '81'}, {label: 'D', text: '99'}],
          bbox: null,
          has_figure: false,
        },
        {
          ordinal: 4,
          prompt_text: 'What is half of 46?',
          question_type: 'multiple_choice',
          choices: [{label: 'A', text: '18'}, {label: 'B', text: '21'}, {label: 'C', text: '23'}, {label: 'D', text: '26'}],
          bbox: null,
          has_figure: false,
        },
        {
          ordinal: 5,
          prompt_text: 'Which is largest?',
          question_type: 'multiple_choice',
          choices: [{label: 'A', text: '0.5'}, {label: 'B', text: '0.45'}, {label: 'C', text: '0.09'}, {label: 'D', text: '0.499'}],
          bbox: null,
          has_figure: false,
        },
      ],
    ],
  },
]

function squash(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

// The cached path hands back a fully extracted worksheet without touching the
// trial counter, so a sample each is a giveaway but a sample every time is a
// way to process unlimited worksheets free. The userId is required rather than
// optional on purpose: the cap cannot then be skipped by a caller that forgets
// it, which is how this was uncapped to begin with.
export async function findMatchingSample(
  db: Db,
  worksheetId: string,
  userId: string,
): Promise<{sample: CachedSample; pages: {id: string}[]} | null> {
  const pages = await db
    .select({id: worksheetPages.id, ocrText: worksheetPages.ocrText})
    .from(worksheetPages)
    .where(eq(worksheetPages.worksheetId, worksheetId))
    .orderBy(asc(worksheetPages.pageNumber))

  if (pages.length === 0) return null

  const firstPage = squash(pages[0].ocrText ?? '')

  for (const sample of CACHED_SAMPLES) {
    if (pages.length !== sample.pages.length) continue
    if (!firstPage.includes(squash(sample.title))) continue

    const [used] = await db
      .select({id: worksheets.id})
      .from(worksheets)
      .where(and(eq(worksheets.userId, userId), eq(worksheets.sampleSlug, sample.slug)))
      .limit(1)

    if (used) return null

    return {sample, pages}
  }

  return null
}

export async function applyCachedSample(
  db: Db,
  worksheetId: string,
  userId: string,
  sample: CachedSample,
  pages: {id: string}[],
): Promise<number> {
  let total = 0

  for (const [index, page] of pages.entries()) {
    total += await persistQuestions(db, {worksheetId, userId}, page.id, sample.pages[index])
  }

  const [topic] = await db
    .select({id: topics.id})
    .from(topics)
    .where(eq(topics.slug, sample.topicSlug))
    .limit(1)

  if (!topic) return total

  const rows = await db
    .select({id: questions.id})
    .from(questions)
    .where(eq(questions.worksheetId, worksheetId))

  if (rows.length === 0) return total

  await db
    .insert(questionTopics)
    .values(
      rows.map((row) => ({
        questionId: row.id,
        topicId: topic.id,
        confidence: 1,
        assignedBy: 'ai' as const,
        isPrimary: true,
      })),
    )
    .onConflictDoNothing()

  return total
}
