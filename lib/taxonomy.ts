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

export type TopicNode = {
  name: string
  slug?: string
  children?: TopicNode[]
}

function n(name: string, ...children: TopicNode[]): TopicNode {
  if (children.length === 0) return {name}

  return {name, children}
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

export type FlatTopic = {
  slug: string
  name: string
  parentSlug: string | null
  depth: number
  subjectRoot: string
  isLeaf: boolean
  path: string
}

function slugSegment(name: string) {
  const segment = name
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

  if (!segment) return 'topic'

  return segment
}

function build(roots: TopicNode[]) {
  const out: FlatTopic[] = []
  const seen = new Set<string>()

  function walk(
    node: TopicNode,
    parentSlug: string | null,
    depth: number,
    subjectRoot: string,
    parentPath: string[],
  ) {
    let segment = node.slug
    if (!segment) segment = slugSegment(node.name)

    let slug = segment
    if (parentSlug) slug = parentSlug + '.' + segment

    if (seen.has(slug)) {
      throw new Error('Duplicate topic slug "' + slug + '"; rename one of the siblings.')
    }

    seen.add(slug)

    const path = parentPath.slice()
    path.push(node.name)

    let children: TopicNode[] = []
    if (node.children) children = node.children

    out.push({
      slug,
      name: node.name,
      parentSlug,
      depth,
      subjectRoot,
      isLeaf: children.length === 0,
      path: path.join(' › '),
    })

    for (const child of children) {
      walk(child, slug, depth + 1, subjectRoot, path)
    }
  }

  for (const root of roots) {
    let subjectRoot = root.slug
    if (!subjectRoot) subjectRoot = slugSegment(root.name)

    walk(root, null, 0, subjectRoot, [])
  }

  return out
}

let flattened: readonly FlatTopic[] | null = null

export function flattenTaxonomy(): FlatTopic[] {
  if (!flattened) flattened = Object.freeze(build(TAXONOMY))

  return flattened as FlatTopic[]
}

let paths: Map<string, string> | null = null

export function pathBySlug(): ReadonlyMap<string, string> {
  if (!paths) {
    paths = new Map<string, string>()
    for (const topic of flattenTaxonomy()) paths.set(topic.slug, topic.path)
  }

  return paths
}

export async function demoteParentsWithChildren(db: Db) {
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

  const slugs: string[] = []
  for (const row of corrected) slugs.push(row.slug)

  return slugs
}

const SHORTLIST_SIZE = 25

export type ClassifyOutcome = {
  topicId: string | null
  coarse: boolean
  confidence: number
}

export function isEmbedding(value: unknown): value is number[] {
  if (!Array.isArray(value)) return false
  if (value.length !== EMBEDDING_DIMENSIONS) return false

  for (const entry of value) {
    if (typeof entry !== 'number') return false
    if (!Number.isFinite(entry)) return false
  }

  return true
}

export type ShortlistOptions = {
  subjectHint?: string | null
  limit?: number
}

function subjectSubtree(subjectHint: string | null | undefined) {
  if (!subjectHint) return undefined

  const hint = subjectHint.trim()
  if (!hint || !pathBySlug().has(hint)) return undefined

  const prefix = hint + '.%'

  return sql`(${topics.slug} = ${hint} or ${topics.slug} like ${prefix})`
}

export async function shortlistByVector(
  db: Db,
  vector: number[],
  options: ShortlistOptions = {},
): Promise<TopicCandidate[]> {
  const literal = '[' + vector.join(',') + ']'

  let limit = SHORTLIST_SIZE
  if (options.limit) limit = options.limit

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
    .limit(limit)

  const candidates: TopicCandidate[] = []

  for (const row of rows) {
    let topicPath = pathBySlug().get(row.slug)
    if (!topicPath) topicPath = row.name

    candidates.push({slug: row.slug, name: row.name, path: topicPath})
  }

  return candidates
}

export class EmbeddingUnavailableError extends Error {
  constructor(cause: string) {
    super('The embedding model could not be loaded: ' + cause)
    this.name = 'EmbeddingUnavailableError'
  }
}

async function shortlistTopics(
  db: Db,
  questionId: string,
  questionText: string,
  subjectHint?: string | null,
) {
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

  let chosen: TopicCandidate | null = null

  if (result.topic_slug && !result.abstain) {
    for (const candidate of candidates) {
      if (candidate.slug === result.topic_slug) {
        chosen = candidate
        break
      }
    }
  }

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

  const [nearest] = await db
    .select({id: topics.id})
    .from(topics)
    .where(eq(topics.slug, candidates[0].slug))
    .limit(1)

  if (nearest) {
    await db
      .insert(questionTopics)
      .values({
        questionId: question.id,
        topicId: nearest.id,
        confidence: result.confidence,
        assignedBy: 'ai',
        isPrimary: false,
      })
      .onConflictDoNothing()
  }

  return {topicId: null, coarse: true, confidence: result.confidence}
}

export async function classifyWorksheet(
  db: Db,
  provider: AIProvider,
  worksheetId: string,
  subjectHint?: string | null,
) {
  const rows = await db
    .select({id: questions.id, promptText: questions.promptText, userId: questions.userId})
    .from(questions)
    .where(eq(questions.worksheetId, worksheetId))

  const taggedRows = await db
    .select({questionId: questionTopics.questionId})
    .from(questionTopics)
    .innerJoin(questions, eq(questionTopics.questionId, questions.id))
    .where(eq(questions.worksheetId, worksheetId))

  const tagged = new Set<string>()
  for (const row of taggedRows) tagged.add(row.questionId)

  let classified = 0
  let coarse = 0
  let failed = 0

  for (const question of rows) {
    if (tagged.has(question.id)) continue

    try {
      const outcome = await classifyQuestion(db, provider, question, subjectHint)

      if (outcome.topicId) classified = classified + 1
      if (outcome.coarse) coarse = coarse + 1
    } catch (error) {
      if (error instanceof EmbeddingUnavailableError) throw error

      failed = failed + 1

      console.error(
        '[classify] question ' + question.id + ' could not be classified:',
        (error as Error).message,
      )
    }
  }

  if (failed > 0) {
    console.error(
      '[classify] ' + failed + ' of ' + rows.length + ' question(s) on ' + worksheetId + ' failed',
    )
  }

  return {classified, coarse, failed}
}

const PENDING_PAGE_SIZE = 100

export type PendingQuestion = {
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

export async function pendingQuestionCount(db: Db, worksheetId: string) {
  const [row] = await db
    .select({value: count()})
    .from(questions)
    .where(untagged(db, worksheetId))

  return row.value
}

const VENDORED = path.join(process.cwd(), 'models')

let extractorPromise: Promise<FeatureExtractionPipeline> | null = null

function getExtractor() {
  if (!extractorPromise) {
    extractorPromise = import('@huggingface/transformers').then((mod) => {
      if (existsSync(VENDORED)) {
        mod.env.localModelPath = VENDORED
        mod.env.allowRemoteModels = false
      }

      return mod.pipeline('feature-extraction', EMBEDDING_MODEL, {
        dtype: 'q8',
      }) as Promise<FeatureExtractionPipeline>
    })
  }

  return extractorPromise
}

export async function embed(text: string) {
  const trimmed = text.trim()

  if (!trimmed) {
    const zeros: number[] = []
    for (let i = 0; i < EMBEDDING_DIMENSIONS; i++) zeros.push(0)

    return zeros
  }

  const extractor = await getExtractor()

  const output = await extractor(trimmed.slice(0, EMBEDDING_INPUT_LIMIT), {
    pooling: 'mean',
    normalize: true,
  })

  return Array.from(output.data as Float32Array)
}
