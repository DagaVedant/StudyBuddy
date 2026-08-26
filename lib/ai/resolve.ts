import {createCipheriv, createDecipheriv, randomBytes} from 'node:crypto'

import {and, desc, eq, gte, inArray, sql} from 'drizzle-orm'

import {aiProvider, processingJobs, usageEvents, userAiCredentials, users, worksheets} from '@/lib/schema'
import {type Db} from '@/lib/db'

import {
  AnthropicProvider,
  GeminiProvider,
  OpenAIProvider,
  OpenRouterProvider,
} from './cloud'
import {
  type AIProvider,
  type AnswerInput,
  CLOUD_PROVIDERS,
  type CloudProvider,
  DEFAULT_CLOUD_MODEL,
  type ExplainInput,
  isCloudProvider,
  type LessonInput,
  type PageInput,
  type PracticeInput,
  type ProviderName,
  ProviderUnavailable,
  type RawAIProvider,
  type TopicCandidate,
  TRIAL_EXPLANATION_LIMIT,
  TRIAL_WORKSHEET_LIMIT,
  validated,
} from './types'

export {CLOUD_PROVIDERS, DEFAULT_CLOUD_MODEL, type CloudProvider}

export type Tier = 'trial' | 'free' | 'cloud' | 'ollama'

export interface ResolvedProvider {
  provider: AIProvider
  tier: Tier
  executor: 'server' | 'browser' | 'operator_gpu' | 'none'
}

export function browserTierEnabled(): boolean {
  return process.env.ENABLE_BROWSER_TIER === 'true'
}

export function cloudExtractionEnabled(): boolean {
  return process.env.ENABLE_CLOUD_EXTRACTION === 'true'
}

export function mockEnabled(): boolean {
  return process.env.ENABLE_MOCK_AI === 'true'
}

export async function resolveProvider(
  db: Db,
  userId: string,
): Promise<ResolvedProvider> {
  const [user] = await db
    .select({trialWorksheetsUsed: users.trialWorksheetsUsed, role: users.role})
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)

  const credentials = await db
    .select()
    .from(userAiCredentials)
    .where(eq(userAiCredentials.userId, userId))

  const cloud = credentials.find(
    (row) =>
      isCloudProvider(row.provider) && row.encryptedKey && row.keyIv && row.keyAuthTag,
  )

  if (cloud) {
    if (mockEnabled()) {
      return {provider: validated(new MockProvider()), tier: 'cloud', executor: 'server'}
    }

    const apiKey = openApiKey({
      ciphertext: cloud.encryptedKey!,
      iv: cloud.keyIv!,
      authTag: cloud.keyAuthTag!,
    })

    return {
      provider: cloudProvider(
        cloud.provider as CloudProvider,
        apiKey,
        cloud.visionModelName ?? cloud.modelName ?? undefined,
      ),
      tier: 'cloud',
      executor: 'server',
    }
  }

  const ollama = credentials.find(
    (row) => row.provider === 'ollama' && row.ollamaBaseUrl,
  )

  if (ollama) {
    if (mockEnabled()) {
      return {provider: validated(new MockProvider()), tier: 'ollama', executor: 'server'}
    }

    return {
      provider: validated(new NullProvider()),
      tier: 'ollama',
      executor: browserTierEnabled() ? 'browser' : 'operator_gpu',
    }
  }

  if (user?.role === 'admin') {
    return {
      provider: validated(mockEnabled() ? new MockProvider() : new NullProvider()),
      tier: 'trial',
      executor: 'operator_gpu',
    }
  }

  const worksheetsUsed = user?.trialWorksheetsUsed ?? 0
  if (worksheetsUsed < TRIAL_WORKSHEET_LIMIT) {
    return {
      provider: validated(mockEnabled() ? new MockProvider() : new NullProvider()),
      tier: 'trial',
      executor: 'operator_gpu',
    }
  }

  return {provider: validated(new NullProvider()), tier: 'free', executor: 'none'}
}

export function cloudProvider(
  provider: CloudProvider,
  apiKey: string,
  model?: string,
): AIProvider {
  return validated(rawCloudProvider(provider, apiKey, model))
}

function rawCloudProvider(
  provider: CloudProvider,
  apiKey: string,
  model?: string,
): RawAIProvider {
  const chosen = model || DEFAULT_CLOUD_MODEL[provider]

  switch (provider) {
    case 'anthropic':
      return new AnthropicProvider(apiKey, chosen)
    case 'openai':
      return new OpenAIProvider(apiKey, chosen)
    case 'openrouter':
      return new OpenRouterProvider(apiKey, chosen)
    case 'google':
      return new GeminiProvider(apiKey, chosen)
  }
}

export interface CredentialSummary {
  provider: StoredProvider
  keyLast4: string | null
  ollamaBaseUrl: string | null
  modelName: string | null
  visionModelName: string | null
  verifiedAt: Date | null
}

export function canSortTopicsHere(credentials: CredentialSummary[]): boolean {
  return credentials.some(
    (row) =>
      isCloudProvider(row.provider) ||
      (row.provider === 'ollama' && Boolean(row.ollamaBaseUrl)),
  )
}

export async function getCredentialSummary(
  db: Db,
  userId: string,
): Promise<CredentialSummary[]> {
  return db
    .select({
      provider: userAiCredentials.provider,
      keyLast4: userAiCredentials.keyLast4,
      ollamaBaseUrl: userAiCredentials.ollamaBaseUrl,
      modelName: userAiCredentials.modelName,
      visionModelName: userAiCredentials.visionModelName,
      verifiedAt: userAiCredentials.verifiedAt,
    })
    .from(userAiCredentials)
    .where(eq(userAiCredentials.userId, userId))
}

export async function deleteCredential(
  db: Db,
  userId: string,
  provider: CloudProvider | 'ollama',
): Promise<void> {
  await db
    .delete(userAiCredentials)
    .where(
      and(
        eq(userAiCredentials.userId, userId),
        eq(userAiCredentials.provider, provider),
      ),
    )
}

export type StoredProvider = (typeof aiProvider.enumValues)[number]

export function storedProvider(name: ProviderName): StoredProvider | null {
  return isStored(name) ? name : null
}

function isStored(name: string): name is StoredProvider {
  return (aiProvider.enumValues as readonly string[]).includes(name)
}

export {TRIAL_EXPLANATION_LIMIT, TRIAL_WORKSHEET_LIMIT}

export type TrialKind = 'worksheets' | 'explanations'

export interface TrialState {
  worksheetsUsed: number
  worksheetsRemaining: number
  explanationsUsed: number
  explanationsRemaining: number
  exhausted: boolean
}

export async function getTrialState(db: Db, userId: string): Promise<TrialState> {
  const [row] = await db
    .select({
      worksheetsUsed: users.trialWorksheetsUsed,
      explanationsUsed: users.trialExplanationsUsed,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)

  const worksheetsUsed = row?.worksheetsUsed ?? 0
  const explanationsUsed = row?.explanationsUsed ?? 0

  const worksheetsRemaining = Math.max(0, TRIAL_WORKSHEET_LIMIT - worksheetsUsed)
  const explanationsRemaining = Math.max(
    0,
    TRIAL_EXPLANATION_LIMIT - explanationsUsed,
  )

  return {
    worksheetsUsed,
    worksheetsRemaining,
    explanationsUsed,
    explanationsRemaining,
    exhausted: worksheetsRemaining === 0 && explanationsRemaining === 0,
  }
}

export type ConsumeResult =
  | {ok: true; remaining: number}
  | {ok: false; remaining: number; reason: string}

function columnFor(kind: TrialKind) {
  return kind === 'worksheets' ? users.trialWorksheetsUsed : users.trialExplanationsUsed
}

function fieldFor(kind: TrialKind) {
  return kind === 'worksheets' ? 'trialWorksheetsUsed' : 'trialExplanationsUsed'
}

function eventKindFor(kind: TrialKind) {
  return kind === 'worksheets' ? 'extract_page' : 'explain'
}

export async function consumeTrial(
  db: Db,
  userId: string,
  kind: TrialKind,
  amount = 1,
): Promise<ConsumeResult> {
  if (amount <= 0) return {ok: true, remaining: 0}

  const column = columnFor(kind)
  const limit = kind === 'worksheets' ? TRIAL_WORKSHEET_LIMIT : TRIAL_EXPLANATION_LIMIT

  const updated = await db
    .update(users)
    .set({[fieldFor(kind)]: sql`${column} + ${amount}`})
    .where(and(eq(users.id, userId), sql`${column} + ${amount} <= ${limit}`))
    .returning({
      worksheetsUsed: users.trialWorksheetsUsed,
      explanationsUsed: users.trialExplanationsUsed,
    })

  if (updated.length === 0) {
    const state = await getTrialState(db, userId)
    const remaining =
      kind === 'worksheets' ? state.worksheetsRemaining : state.explanationsRemaining
    const noun = kind === 'worksheets' ? 'worksheets' : 'explanations'

    return {
      ok: false,
      remaining,
      reason:
        `Your free trial covers ${limit} ${noun} and you have ${remaining} left. ` +
        'Everything here is read on one GPU we run, so the free allowance is capped.',
    }
  }

  const used =
    kind === 'worksheets' ? updated[0].worksheetsUsed : updated[0].explanationsUsed

  await db.insert(usageEvents).values({
    userId,
    kind: eventKindFor(kind),
    tierUsed: 'trial',
    quantity: amount,
  })

  return {ok: true, remaining: Math.max(0, limit - used)}
}

export async function refundTrial(
  db: Db,
  userId: string,
  kind: TrialKind,
  amount = 1,
): Promise<void> {
  if (amount <= 0) return

  const column = columnFor(kind)

  await db
    .update(users)
    .set({[fieldFor(kind)]: sql`greatest(${column} - ${amount}, 0)`})
    .where(eq(users.id, userId))

  const pending = await db
    .select({id: usageEvents.id, quantity: usageEvents.quantity})
    .from(usageEvents)
    .where(
      and(
        eq(usageEvents.userId, userId),
        eq(usageEvents.kind, eventKindFor(kind)),
        eq(usageEvents.tierUsed, 'trial'),
        eq(usageEvents.refunded, false),
      ),
    )
    .orderBy(desc(usageEvents.createdAt))

  const refunding: string[] = []
  let covered = 0

  for (const event of pending) {
    if (covered >= amount) break
    refunding.push(event.id)
    covered += event.quantity
  }

  if (refunding.length > 0) {
    await db
      .update(usageEvents)
      .set({refunded: true})
      .where(inArray(usageEvents.id, refunding))
  }
}

const DAY_MS = 24 * 3600_000

export async function trialExtractionsToday(db: Db): Promise<number> {
  const since = new Date(Date.now() - DAY_MS)

  const [row] = await db
    .select({value: sql<number>`count(*)::int`})
    .from(processingJobs)
    .innerJoin(worksheets, eq(worksheets.id, processingJobs.worksheetId))
    .where(
      and(
        eq(processingJobs.stage, 'extract'),
        eq(processingJobs.executor, 'operator_gpu'),
        eq(worksheets.tierUsed, 'trial'),
        gte(processingJobs.createdAt, since),
      ),
    )

  return row.value
}

const ALGORITHM = 'aes-256-gcm'
const IV_BYTES = 12

export interface SealedKey {
  ciphertext: string
  iv: string
  authTag: string
  last4: string
}

function masterKey(): Buffer {
  const raw = process.env.CREDENTIALS_ENC_KEY
  if (!raw) {
    throw new Error('CREDENTIALS_ENC_KEY is not set; cannot handle API keys.')
  }

  const key = Buffer.from(raw, 'base64')
  if (key.length !== 32) {
    throw new Error(
      'CREDENTIALS_ENC_KEY must be 32 bytes base64-encoded. Generate one with: ' +
        'node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"',
    )
  }

  return key
}

export function sealApiKey(plaintext: string): SealedKey {
  const trimmed = plaintext.trim()
  if (!trimmed) throw new Error('Cannot store an empty API key.')

  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGORITHM, masterKey(), iv)

  const ciphertext = Buffer.concat([cipher.update(trimmed, 'utf8'), cipher.final()])

  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
    last4: trimmed.slice(-4),
  }
}

function openApiKey(sealed: {ciphertext: string; iv: string; authTag: string}): string {
  const decipher = createDecipheriv(
    ALGORITHM,
    masterKey(),
    Buffer.from(sealed.iv, 'base64'),
  )
  decipher.setAuthTag(Buffer.from(sealed.authTag, 'base64'))

  return Buffer.concat([
    decipher.update(Buffer.from(sealed.ciphertext, 'base64')), decipher.final(),
  ]).toString('utf8')
}

export function isAllowedOllamaUrl(value: string): boolean {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false

  const host = url.hostname.toLowerCase()
  return (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host === '[::1]' ||
    host.endsWith('.localhost')
  )
}

const VERIFY_TIMEOUT_MS = 10_000

export type KeyVerdict =
  | {status: 'ok'}
  | {status: 'rejected'; reason: string}
  | {status: 'unreachable'; reason: string}

function probe(provider: CloudProvider, apiKey: string): [string, RequestInit] {
  switch (provider) {
    case 'anthropic':
      return [
        'https://api.anthropic.com/v1/models?limit=1',
        {headers: {'x-api-key': apiKey, 'anthropic-version': '2023-06-01'}},
      ]
    case 'openai':
      return [
        'https://api.openai.com/v1/models', {headers: {authorization: `Bearer ${apiKey}`}},
      ]
    case 'openrouter':
      return [
        'https://openrouter.ai/api/v1/key', {headers: {authorization: `Bearer ${apiKey}`}},
      ]
    case 'google':
      return [
        `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}&pageSize=1`,
        {},
      ]
  }
}

export async function verifyCloudKey(
  provider: CloudProvider,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<KeyVerdict> {
  if (mockEnabled()) {
    return {status: 'unreachable', reason: 'mock mode is on, so nothing was checked'}
  }

  const [url, init] = probe(provider, apiKey)

  let response: Response
  try {
    response = await fetchImpl(url, {
      ...init,
      method: 'GET',
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
    })
  } catch (error) {
    return {
      status: 'unreachable',
      reason: error instanceof Error ? error.message : 'the provider did not answer',
    }
  }

  if (response.ok) return {status: 'ok'}

  if (response.status === 401 || response.status === 403) {
    return {status: 'rejected', reason: `${provider} did not accept that key.`}
  }

  return {status: 'unreachable', reason: `${provider} answered ${response.status}.`}
}

class MockProvider implements RawAIProvider {
  readonly name = 'mock' as const
  readonly model = 'mock' as const
  readonly answeringModel = 'mock' as const
  readonly supportsVision = true
  readonly executionSite = 'server' as const

  async extractQuestions(page: PageInput): Promise<unknown> {
    const lines = page.text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /^\s*\d+[.)]\s+/.test(line))
      .slice(0, 40)

    if (lines.length === 0) {
      return {
        questions: [
          {
            ordinal: 1,
            prompt_text: `Sample question from page ${page.pageNumber}`,
            question_type: 'multiple_choice',
            choices: [
              {label: 'A', text: 'First option'}, {label: 'B', text: 'Second option'},
            ],
            bbox: [0, 0, Math.min(page.width, 100), Math.min(page.height, 100)],
            has_figure: false,
          },
        ],
      }
    }

    return {
      questions: lines.map((line, index) => ({
        ordinal: index + 1,
        prompt_text: line.replace(/^\s*\d+[.)]\s+/, ''),
        question_type: 'multiple_choice' as const,
        choices: [
          {label: 'A', text: 'Option A'}, {label: 'B', text: 'Option B'},
          {label: 'C', text: 'Option C'}, {label: 'D', text: 'Option D'},
        ],
        bbox: null,
        has_figure: false,
      })),
    }
  }

  async classifyTopic(
    promptText: string,
    candidates: TopicCandidate[],
  ): Promise<unknown> {
    if (candidates.length === 0) {
      return {topic_slug: null, confidence: 0, abstain: true}
    }

    const words = new Set(
      promptText
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((word) => word.length > 3),
    )

    let best = candidates[0]
    let bestScore = -1

    for (const candidate of candidates) {
      const score = candidate.name
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((word) => words.has(word)).length
      if (score > bestScore) {
        best = candidate
        bestScore = score
      }
    }

    if (bestScore <= 0) {
      return {topic_slug: null, confidence: 0.1, abstain: true}
    }

    return {
      topic_slug: best.slug,
      confidence: Math.min(0.5 + bestScore * 0.15, 0.95),
      abstain: false,
    }
  }

  async answerQuestion(input: AnswerInput): Promise<unknown> {
    const answer = input.choices[0]?.label ?? '42'

    return {
      answer,
      working: `Mock working for: ${input.promptText.slice(0, 60)}`,
      traps: input.choices.slice(1).map((choice) => ({
        label: choice.label,
        why: `Mock trap for ${choice.label}.`,
      })),
      confidence: 0.9,
    }
  }

  async teachTopic(input: LessonInput): Promise<unknown> {
    return {
      body_md: `## ${input.topicName}

Mock lesson for ${input.topicPath}.`,
      examples: [
        {question: 'Mock example one', working: 'Step one.', answer: '1'},
        {question: 'Mock example two', working: 'Step one.', answer: '2'},
      ],
      common_errors: [{mistake: 'Mock mistake', why: 'Mock reason', fix: 'Mock fix'}],
    }
  }

  async writePractice(input: PracticeInput): Promise<unknown> {
    const wanted = Math.max(1, Math.min(input.count, 10))

    return {
      questions: Array.from({length: wanted}, (_, index) => {
        const first = index + 2
        const second = index + 3

        return {
          prompt_text: `A shelf holds ${first} boxes and each box holds ${second} pens. How many pens are on the shelf?`,
          choices: [
            {label: 'A', text: String(first * second)},
            {label: 'B', text: String(first + second)},
            {label: 'C', text: String(first * second - first)},
            {label: 'D', text: String(first * second + second)},
          ],
          correct_label: 'A',
          working: `Multiply the number of boxes by the pens in each box: ${first} x ${second} = ${first * second}.`,
        }
      }),
    }
  }

  async explain(input: ExplainInput): Promise<unknown> {
    const chosen = input.studentAnswer
    const correct = input.correctAnswer ?? 'not recorded'

    return {
      body_md: chosen
        ? `You answered **${chosen}**, but the correct answer is **${correct}**. Work back through the question and check which step produced ${chosen} instead.`
        : `The correct answer is **${correct}**.`,
      misconception_note: chosen ? `Chose ${chosen} instead of ${correct}.` : null,
    }
  }
}

class NullProvider implements RawAIProvider {
  readonly name = 'null' as const
  readonly model = 'none' as const
  readonly answeringModel = 'none' as const
  readonly supportsVision = false
  readonly executionSite = 'none' as const

  async extractQuestions(_page: PageInput): Promise<unknown> {
    throw new ProviderUnavailable()
  }

  async classifyTopic(
    _promptText: string,
    _candidates: TopicCandidate[],
  ): Promise<unknown> {
    throw new ProviderUnavailable()
  }

  async answerQuestion(_input: AnswerInput): Promise<unknown> {
    throw new ProviderUnavailable()
  }

  async teachTopic(_input: LessonInput): Promise<unknown> {
    throw new ProviderUnavailable()
  }

  async writePractice(_input: PracticeInput): Promise<unknown> {
    throw new ProviderUnavailable()
  }

  async explain(_input: ExplainInput): Promise<unknown> {
    throw new ProviderUnavailable()
  }
}
