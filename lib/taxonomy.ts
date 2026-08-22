import path from 'node:path'
import {existsSync} from 'node:fs'

import {alias} from 'drizzle-orm/pg-core'
import {and, asc, count, eq, exists, isNotNull, notExists, sql} from 'drizzle-orm'
import {type FeatureExtractionPipeline} from '@huggingface/transformers'

import {
  EMBEDDING_DIMENSIONS,
  EMBEDDING_INPUT_LIMIT,
  EMBEDDING_MODEL,
} from '@/lib/upload'
import {questions, questionTopics, topics} from '@/lib/schema'
import {type AIProvider, type TopicCandidate} from '@/lib/ai/types'
import {type Db} from '@/lib/db'

export interface TopicNode {
  name: string
  slug?: string
  children?: TopicNode[]
}

function n(name: string, ...children: TopicNode[]): TopicNode {
  return children.length ? {name, children} : {name}
}

const satMath = n(
  'SAT Math',
  n(
    'Algebra',
    n('Linear equations in one variable'),
    n('Linear equations in two variables'),
    n('Linear functions'),
    n('Systems of two linear equations in two variables'),
    n('Linear inequalities in one or two variables'),
  ),
  n(
    'Advanced Math',
    n('Equivalent expressions'),
    n('Nonlinear equations in one variable'),
    n('Systems of nonlinear equations'),
    n('Nonlinear functions'),
  ),
  n(
    'Problem-Solving and Data Analysis',
    n('Ratios, rates, and proportional relationships'),
    n('Units and unit conversion'),
    n('Percentages'),
    n('One-variable data: center and spread'),
    n('Two-variable data: models and scatterplots'),
    n('Probability and conditional probability'),
    n('Inference from sample statistics and margin of error'),
    n('Evaluating statistical claims'),
  ),
  n(
    'Geometry and Trigonometry',
    n('Area and volume'),
    n('Lines, angles, and triangles'),
    n('Right triangles and trigonometry'),
    n('Circles'),
  ),
)

const satReadingWriting = n(
  'SAT Reading and Writing',
  n(
    'Information and Ideas',
    n('Central ideas and details'),
    n('Command of evidence: textual'),
    n('Command of evidence: quantitative'),
    n('Inferences'),
  ),
  n(
    'Craft and Structure',
    n('Words in context'),
    n('Text structure and purpose'),
    n('Cross-text connections'),
  ),
  n('Expression of Ideas', n('Rhetorical synthesis'), n('Transitions')),
  n(
    'Standard English Conventions',
    n('Boundaries'),
    n('Form, structure, and sense'),
  ),
)

const competitionMath = n(
  'Competition Math',
  n(
    'Arithmetic and Number Sense',
    n('Fraction and decimal operations'),
    n('Repeating decimals'),
    n('Integers, negatives and absolute value'),
    n('Order of operations'),
    n('Squares, cubes and roots'),
    n('Radicals and simplification'),
    n('Scientific notation and estimation'),
  ),
  n(
    'Number Theory',
    n('Primes and divisibility'),
    n('Factors and multiples'),
    n('Greatest common divisor and least common multiple'),
    n('Remainders and modular arithmetic'),
    n('Digits and place value'),
    n('Number bases'),
  ),
  n(
    'Ratio, Proportion and Percent',
    n('Ratios and rates'),
    n('Proportional reasoning'),
    n('Percent of a number'),
    n('Percent increase and decrease'),
    n('Successive percent change'),
    n('Working backwards from a percent'),
    n('Discount, markup and tax'),
    n('Unit conversion'),
    n('Speed, distance and time'),
    n('Work and mixture problems'),
  ),
  n(
    'Algebra',
    n('Linear equations'),
    n('Inequalities'),
    n('Systems of equations'),
    n('Word problems into equations'),
    n('Quadratics and factoring'),
    n('Radical equations'),
    n('Exponents and exponential change'),
    n('Sequences and series'),
    n('Slope, intercepts and linear graphs'),
    n('Functions and function notation'),
  ),
  n(
    'Counting and Probability',
    n('Fundamental counting principle'),
    n('Permutations and combinations'),
    n('Probability of an event'),
    n('Probability without replacement'),
    n('Complementary counting and casework'),
    n('Expected value'),
  ),
  n(
    'Geometry',
    n('Angles, lines and segments'),
    n('Triangles'),
    n('Right triangles and the Pythagorean theorem'),
    n('Similarity and congruence'),
    n('Quadrilaterals and polygons'),
    n('Circles'),
    n('Area and perimeter'),
    n('Solids, surface area and volume'),
    n('Coordinate geometry'),
    n('Transformations'),
  ),
  n(
    'Statistics and Data',
    n('Mean, median, mode and range'),
    n('Reading graphs and data displays'),
  ),
  n(
    'Problem Solving Strategies',
    n('Working backwards'),
    n('Patterns and invariants'),
    n('Pigeonhole and extremal reasoning'),
    n('Logical reasoning and proof'),
  ),
)

const TAXONOMY: TopicNode[] = [satMath, satReadingWriting, competitionMath]

export interface FlatTopic {
  slug: string
  name: string
  parentSlug: string | null
  depth: number
  subjectRoot: string
  isLeaf: boolean
  path: string
}

function slugSegment(name: string): string {
  const segment = name
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

  return segment || 'topic'
}

function build(roots: TopicNode[]): FlatTopic[] {
  const out: FlatTopic[] = []
  const seen = new Set<string>()

  function walk(
    node: TopicNode,
    parentSlug: string | null,
    depth: number,
    subjectRoot: string,
    parentPath: string[],
  ) {
    const segment = node.slug ?? slugSegment(node.name)
    const slug = parentSlug ? `${parentSlug}.${segment}` : segment

    if (seen.has(slug)) {
      throw new Error(`Duplicate topic slug "${slug}"; rename one of the siblings.`)
    }
    seen.add(slug)

    const path = [...parentPath, node.name]

    out.push({
      slug,
      name: node.name,
      parentSlug,
      depth,
      subjectRoot,
      isLeaf: !node.children?.length,
      path: path.join(' › '),
    })

    for (const child of node.children ?? []) {
      walk(child, slug, depth + 1, subjectRoot, path)
    }
  }

  for (const root of roots) {
    walk(root, null, 0, root.slug ?? slugSegment(root.name), [])
  }

  return out
}

let flattened: readonly FlatTopic[] | null = null

export function flattenTaxonomy(): FlatTopic[] {
  flattened ??= Object.freeze(build(TAXONOMY))
  return flattened as FlatTopic[]
}

let paths: Map<string, string> | null = null

export function pathBySlug(): ReadonlyMap<string, string> {
  paths ??= new Map(flattenTaxonomy().map((topic) => [topic.slug, topic.path]))
  return paths
}

export async function demoteParentsWithChildren(db: Db): Promise<string[]> {
  const child = alias(topics, 'child')

  const corrected = await db
    .update(topics)
    .set({isLeaf: false})
    .where(
      and(
        eq(topics.isLeaf, true),
        exists(
          db
            .select({one: sql`1`})
            .from(child)
            .where(eq(child.parentId, topics.id)),
        ),
      ),
    )
    .returning({slug: topics.slug})

  return corrected.map((row) => row.slug)
}

const SHORTLIST_SIZE = 25

export interface ClassifyOutcome {
  topicId: string | null
  coarse: boolean
  confidence: number
}

export function isEmbedding(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.length === EMBEDDING_DIMENSIONS &&
    value.every((entry) => typeof entry === 'number' && Number.isFinite(entry))
  )
}

export interface ShortlistOptions {
  subjectHint?: string | null
  limit?: number
}

function subjectSubtree(subjectHint: string | null | undefined) {
  const hint = subjectHint?.trim()
  if (!hint || !pathBySlug().has(hint)) return undefined

  return sql`(${topics.slug} = ${hint} or ${topics.slug} like ${`${hint}.%`})`
}

export async function shortlistByVector(
  db: Db,
  vector: number[],
  options: ShortlistOptions = {},
): Promise<TopicCandidate[]> {
  const literal = `[${vector.join(',')}]`

  const rows = await db
    .select({slug: topics.slug, name: topics.name})
    .from(topics)
    .where(
      and(
        eq(topics.isLeaf, true),
        isNotNull(topics.embedding),
        subjectSubtree(options.subjectHint),
      ),
    )
    .orderBy(sql`${topics.embedding} <=> ${literal}::vector`)
    .limit(options.limit ?? SHORTLIST_SIZE)

  return rows.map((row) => ({
    slug: row.slug,
    name: row.name,
    path: pathBySlug().get(row.slug) ?? row.name,
  }))
}

export class EmbeddingUnavailableError extends Error {
  constructor(cause: string) {
    super(`The embedding model could not be loaded: ${cause}`)
    this.name = 'EmbeddingUnavailableError'
  }
}

async function shortlistTopics(
  db: Db,
  questionId: string,
  questionText: string,
  subjectHint?: string | null,
): Promise<TopicCandidate[]> {
  let vector: number[]
  try {
    vector = await embed(questionText)
  } catch (error) {
    throw new EmbeddingUnavailableError((error as Error).message)
  }

  await db.update(questions).set({embedding: vector}).where(eq(questions.id, questionId))

  return shortlistByVector(db, vector, {subjectHint})
}

async function classifyQuestion(
  db: Db,
  provider: AIProvider,
  question: {id: string; promptText: string; userId: string},
  subjectHint?: string | null,
): Promise<ClassifyOutcome> {
  const candidates = await shortlistTopics(db, question.id, question.promptText, subjectHint)

  if (candidates.length === 0) {
    return {topicId: null, coarse: false, confidence: 0}
  }

  const result = await provider.classifyTopic(question.promptText, candidates)

  return applyClassification(db, question, candidates, result)
}

export async function applyClassification(
  db: Db,
  question: {id: string; promptText: string; userId: string},
  candidates: TopicCandidate[],
  result: {
    topic_slug: string | null
    confidence: number
    abstain: boolean
  },
): Promise<ClassifyOutcome> {
  if (candidates.length === 0) {
    return {topicId: null, coarse: false, confidence: 0}
  }

  const chosen =
    result.topic_slug && !result.abstain
      ? candidates.find((candidate) => candidate.slug === result.topic_slug)
      : undefined

  if (chosen) {
    const [topic] = await db
      .select({id: topics.id})
      .from(topics)
      .where(eq(topics.slug, chosen.slug))
      .limit(1)

    if (topic) {
      await db
        .insert(questionTopics)
        .values({
          questionId: question.id,
          topicId: topic.id,
          confidence: result.confidence,
          assignedBy: 'ai',
          isPrimary: true,
        })
        .onConflictDoNothing()

      return {topicId: topic.id, coarse: false, confidence: result.confidence}
    }
  }

  return {topicId: null, coarse: true, confidence: result.confidence}
}

export async function classifyWorksheet(
  db: Db,
  provider: AIProvider,
  worksheetId: string,
  subjectHint?: string | null,
): Promise<{classified: number; coarse: number; failed: number}> {
  const rows = await db
    .select({id: questions.id, promptText: questions.promptText, userId: questions.userId})
    .from(questions)
    .where(eq(questions.worksheetId, worksheetId))

  const taggedRows = await db
    .select({questionId: questionTopics.questionId})
    .from(questionTopics)
    .innerJoin(questions, eq(questionTopics.questionId, questions.id))
    .where(eq(questions.worksheetId, worksheetId))

  const tagged = new Set(taggedRows.map((row) => row.questionId))

  let classified = 0
  let coarse = 0
  let failed = 0

  for (const question of rows) {
    if (tagged.has(question.id)) continue

    try {
      const outcome = await classifyQuestion(db, provider, question, subjectHint)
      if (outcome.topicId) classified += 1
      if (outcome.coarse) coarse += 1
    } catch (error) {
      if (error instanceof EmbeddingUnavailableError) throw error

      failed += 1
      console.error(
        `[classify] question ${question.id} could not be classified:`,
        (error as Error).message,
      )
    }
  }

  if (failed > 0) {
    console.error(
      `[classify] ${failed} of ${rows.length} question(s) on ${worksheetId} failed`,
    )
  }

  return {classified, coarse, failed}
}

const PENDING_PAGE_SIZE = 100

export interface PendingQuestion {
  id: string
  promptText: string
}

function untagged(db: Db, worksheetId: string) {
  return and(
    eq(questions.worksheetId, worksheetId),
    notExists(
      db
        .select({questionId: questionTopics.questionId})
        .from(questionTopics)
        .where(eq(questionTopics.questionId, questions.id)),
    ),
  )
}

export async function pendingQuestions(
  db: Db,
  worksheetId: string,
  limit: number = PENDING_PAGE_SIZE,
): Promise<PendingQuestion[]> {
  return db
    .select({id: questions.id, promptText: questions.promptText})
    .from(questions)
    .where(untagged(db, worksheetId))
    .orderBy(asc(questions.ordinal), asc(questions.id))
    .limit(limit)
}

export async function pendingQuestionCount(
  db: Db,
  worksheetId: string,
): Promise<number> {
  const [row] = await db
    .select({value: count()})
    .from(questions)
    .where(untagged(db, worksheetId))

  return row.value
}

const VENDORED = path.join(process.cwd(), 'models')

let extractorPromise: Promise<FeatureExtractionPipeline> | null = null

async function getExtractor(): Promise<FeatureExtractionPipeline> {
  extractorPromise ??= import('@huggingface/transformers').then(
    ({env, pipeline}) => {
      if (existsSync(VENDORED)) {
        env.localModelPath = VENDORED
        env.allowRemoteModels = false
      }

      return pipeline('feature-extraction', EMBEDDING_MODEL, {dtype: 'q8'}) as Promise<FeatureExtractionPipeline>
    },
  )

  return extractorPromise
}

export async function embed(text: string): Promise<number[]> {
  const trimmed = text.trim()
  if (!trimmed) return new Array(EMBEDDING_DIMENSIONS).fill(0)

  const extractor = await getExtractor()

  const output = await extractor(trimmed.slice(0, EMBEDDING_INPUT_LIMIT), {
    pooling: 'mean',
    normalize: true,
  })

  return Array.from(output.data as Float32Array)
}
