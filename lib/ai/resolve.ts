import {createCipheriv, createDecipheriv, randomBytes} from 'node:crypto'

import {and, desc, eq, gte, inArray, sql} from 'drizzle-orm'

import {aiProvider, processingJobs, usageEvents, userAiCredentials, users, worksheets} from '@/lib/schema'
import {type Db} from '@/lib/db'
import {recordOperatorCall} from '@/lib/ai/usage'

import {
  AnthropicProvider,
  GeminiProvider,
  OpenAIProvider,
  OpenRouterProvider,
} from './cloud'
import {
  type AIProvider,
  type AnswerInput,
  type BatchAnswerInput,
  type ClassifyBatchInput,
  CLOUD_PROVIDERS,
  type CloudProvider,
  DEFAULT_CLOUD_MODEL,
  type ExecutionSite,
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

export type ResolvedProvider = {
  provider: AIProvider
  tier: Tier
  executor: ExecutionSite
}

export function cloudExtractionEnabled() {
  return process.env.ENABLE_CLOUD_EXTRACTION === 'true'
}

export function mockEnabled() {
  return process.env.ENABLE_MOCK_AI === 'true'
}

function operatorKey() {
  const value = process.env.OPENROUTER_API_KEY
  if (!value) return ''

  return value.trim()
}

export function operatorModel() {
  const value = process.env.OPENROUTER_MODEL
  if (value) return value.trim()

  return DEFAULT_CLOUD_MODEL.openrouter
}

export function operatorFallbackModels() {
  const value = process.env.OPENROUTER_FALLBACK_MODELS
  if (!value) return []

  const models: string[] = []

  for (const part of value.split(',')) {
    const model = part.trim()
    if (model) models.push(model)
  }

  return models
}

export function operatorCloudEnabled() {
  return operatorKey().length > 0
}

function trialProvider(db: Db, idle: RawAIProvider): ResolvedProvider {
  if (mockEnabled()) {
    return {provider: validated(idle), tier: 'trial', executor: 'server'}
  }

  const key = operatorKey()

  if (key) {
    function count() {
      return recordOperatorCall(db)
    }

    return {
      provider: validated(
        new OpenRouterProvider(key, operatorModel(), operatorFallbackModels(), count),
      ),
      tier: 'trial',
      executor: 'server',
    }
  }

  return {provider: validated(idle), tier: 'trial', executor: 'none'}
}

export async function resolveProvider(db: Db, userId: string): Promise<ResolvedProvider> {
  const [user] = await db
    .select({trialWorksheetsUsed: users.trialWorksheetsUsed, role: users.role})
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)

  const credentials = await db
    .select()
    .from(userAiCredentials)
    .where(eq(userAiCredentials.userId, userId))

  for (let row of credentials) {
    if (!isCloudProvider(row.provider)) continue
    if (!row.encryptedKey || !row.keyIv || !row.keyAuthTag) continue

    if (mockEnabled()) {
      return {provider: validated(new MockProvider()), tier: 'cloud', executor: 'server'}
    }

    const apiKey = openApiKey({
      ciphertext: row.encryptedKey,
      iv: row.keyIv,
      authTag: row.keyAuthTag,
    })

    let model: string | undefined = undefined
    if (row.visionModelName !== null) model = row.visionModelName
    else if (row.modelName !== null) model = row.modelName

    return {
      provider: cloudProvider(row.provider as CloudProvider, apiKey, model),
      tier: 'cloud',
      executor: 'server',
    }
  }

  let idle: RawAIProvider = new NullProvider()
  if (mockEnabled()) idle = new MockProvider()

  if (user && user.role === 'admin') {
    return trialProvider(db, idle)
  }

  let worksheetsUsed = 0
  if (user && user.trialWorksheetsUsed) worksheetsUsed = user.trialWorksheetsUsed

  if (worksheetsUsed < TRIAL_WORKSHEET_LIMIT) {
    return trialProvider(db, idle)
  }

  return {provider: validated(new NullProvider()), tier: 'free', executor: 'none'}
}

export function cloudProvider(
  provider: CloudProvider,
  apiKey: string,
  model?: string,
  fallbacks: string[] = [],
) {
  return validated(rawCloudProvider(provider, apiKey, model, fallbacks))
}

function rawCloudProvider(
  provider: CloudProvider,
  apiKey: string,
  model: string | undefined,
  fallbacks: string[],
): RawAIProvider {
  let chosen = model
  if (!chosen) chosen = DEFAULT_CLOUD_MODEL[provider]

  if (provider === 'anthropic') return new AnthropicProvider(apiKey, chosen)
  if (provider === 'openai') return new OpenAIProvider(apiKey, chosen)
  if (provider === 'openrouter') return new OpenRouterProvider(apiKey, chosen, fallbacks)

  return new GeminiProvider(apiKey, chosen)
}

export type StoredProvider = (typeof aiProvider.enumValues)[number]

export type CredentialSummary = {
  provider: StoredProvider
  keyLast4: string | null
  modelName: string | null
  visionModelName: string | null
  verifiedAt: Date | null
}

export async function canSortTopicsHere(db: Db, userId: string) {
  const {executor} = await resolveProvider(db, userId)

  return executor === 'server'
}

export async function getCredentialSummary(
  db: Db,
  userId: string,
): Promise<CredentialSummary[]> {
  return db
    .select({
      provider: userAiCredentials.provider,
      keyLast4: userAiCredentials.keyLast4,
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
  provider: CloudProvider,
) {
  await db
    .delete(userAiCredentials)
    .where(
      and(eq(userAiCredentials.userId, userId), eq(userAiCredentials.provider, provider)),
    )
}

export function storedProvider(name: ProviderName) {
  for (let value of aiProvider.enumValues) {
    if (value === name) return value
  }

  return null
}

export {TRIAL_EXPLANATION_LIMIT, TRIAL_WORKSHEET_LIMIT}

export type TrialKind = 'worksheets' | 'explanations'

export type TrialState = {
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

  let worksheetsUsed = 0
  if (row && row.worksheetsUsed) worksheetsUsed = row.worksheetsUsed

  let explanationsUsed = 0
  if (row && row.explanationsUsed) explanationsUsed = row.explanationsUsed

  let worksheetsRemaining = TRIAL_WORKSHEET_LIMIT - worksheetsUsed
  if (worksheetsRemaining < 0) worksheetsRemaining = 0

  let explanationsRemaining = TRIAL_EXPLANATION_LIMIT - explanationsUsed
  if (explanationsRemaining < 0) explanationsRemaining = 0

  return {
    worksheetsUsed: worksheetsUsed,
    worksheetsRemaining: worksheetsRemaining,
    explanationsUsed: explanationsUsed,
    explanationsRemaining: explanationsRemaining,
    exhausted: worksheetsRemaining === 0 && explanationsRemaining === 0,
  }
}

export type ConsumeResult = {
  ok: boolean
  remaining: number
  reason: string
}

export async function consumeTrial(
  db: Db,
  userId: string,
  kind: TrialKind,
  amount = 1,
): Promise<ConsumeResult> {
  if (amount <= 0) return {ok: true, remaining: 0, reason: ''}

  let column = sql`${users.trialExplanationsUsed}`
  let field: 'trialExplanationsUsed' | 'trialWorksheetsUsed' = 'trialExplanationsUsed'
  let eventKind: 'explain' | 'extract_page' = 'explain'
  let limit = TRIAL_EXPLANATION_LIMIT
  let noun = 'explanations'

  if (kind === 'worksheets') {
    column = sql`${users.trialWorksheetsUsed}`
    field = 'trialWorksheetsUsed'
    eventKind = 'extract_page'
    limit = TRIAL_WORKSHEET_LIMIT
    noun = 'worksheets'
  }

  const updated = await db
    .update(users)
    .set({[field]: sql`${column} + ${amount}`})
    .where(and(eq(users.id, userId), sql`${column} + ${amount} <= ${limit}`))
    .returning({
      worksheetsUsed: users.trialWorksheetsUsed,
      explanationsUsed: users.trialExplanationsUsed,
    })

  if (updated.length === 0) {
    const state = await getTrialState(db, userId)

    let remaining = state.explanationsRemaining
    if (kind === 'worksheets') remaining = state.worksheetsRemaining

    return {
      ok: false,
      remaining: remaining,
      reason:
        'Your free trial covers ' +
        limit +
        ' ' +
        noun +
        ' and you have ' +
        remaining +
        ' left. Reading a paper costs real money, so the free allowance is capped. ' +
        'StudyBuddy stays free after that: you add the questions yourself, or you ' +
        'connect your own AI provider in settings and there is no cap at all.',
    }
  }

  let used = updated[0].explanationsUsed
  if (kind === 'worksheets') used = updated[0].worksheetsUsed

  await db.insert(usageEvents).values({
    userId,
    kind: eventKind,
    tierUsed: 'trial',
    quantity: amount,
  })

  let remaining = limit - used
  if (remaining < 0) remaining = 0

  return {ok: true, remaining: remaining, reason: ''}
}

export async function refundTrial(db: Db, userId: string, kind: TrialKind, amount = 1) {
  if (amount <= 0) return

  let column = sql`${users.trialExplanationsUsed}`
  let field: 'trialExplanationsUsed' | 'trialWorksheetsUsed' = 'trialExplanationsUsed'
  let eventKind: 'explain' | 'extract_page' = 'explain'

  if (kind === 'worksheets') {
    column = sql`${users.trialWorksheetsUsed}`
    field = 'trialWorksheetsUsed'
    eventKind = 'extract_page'
  }

  await db
    .update(users)
    .set({[field]: sql`greatest(${column} - ${amount}, 0)`})
    .where(eq(users.id, userId))

  const pending = await db
    .select({id: usageEvents.id, quantity: usageEvents.quantity})
    .from(usageEvents)
    .where(
      and(
        eq(usageEvents.userId, userId),
        eq(usageEvents.kind, eventKind),
        eq(usageEvents.tierUsed, 'trial'),
        eq(usageEvents.refunded, false),
      ),
    )
    .orderBy(desc(usageEvents.createdAt))

  let refunding: string[] = []
  let covered = 0

  for (let event of pending) {
    if (covered >= amount) break

    refunding.push(event.id)
    covered = covered + event.quantity
  }

  if (refunding.length > 0) {
    await db
      .update(usageEvents)
      .set({refunded: true})
      .where(inArray(usageEvents.id, refunding))
  }
}

export async function trialExtractionsToday(db: Db) {
  const since = new Date(Date.now() - 24 * 3600000)

  const [row] = await db
    .select({value: sql<number>`count(*)::int`})
    .from(processingJobs)
    .innerJoin(worksheets, eq(worksheets.id, processingJobs.worksheetId))
    .where(
      and(
        eq(processingJobs.stage, 'extract'),
        eq(worksheets.tierUsed, 'trial'),
        gte(processingJobs.createdAt, since),
      ),
    )

  return row.value
}

const ALGORITHM = 'aes-256-gcm'
const IV_BYTES = 12

export type SealedKey = {
  ciphertext: string
  iv: string
  authTag: string
  last4: string
}

function masterKey() {
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

function openApiKey(sealed: {ciphertext: string; iv: string; authTag: string}) {
  const decipher = createDecipheriv(
    ALGORITHM,
    masterKey(),
    Buffer.from(sealed.iv, 'base64'),
  )

  decipher.setAuthTag(Buffer.from(sealed.authTag, 'base64'))

  const opened = Buffer.concat([
    decipher.update(Buffer.from(sealed.ciphertext, 'base64')),
    decipher.final(),
  ])

  return opened.toString('utf8')
}

export type KeyVerdict = {
  status: string
  reason: string
}

export async function verifyCloudKey(
  provider: CloudProvider,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<KeyVerdict> {
  if (mockEnabled()) {
    return {status: 'unreachable', reason: 'mock mode is on, so nothing was checked'}
  }

  let url = ''
  let headers: Record<string, string> = {}

  if (provider === 'anthropic') {
    url = 'https://api.anthropic.com/v1/models?limit=1'
    headers = {'x-api-key': apiKey, 'anthropic-version': '2023-06-01'}
  } else if (provider === 'openai') {
    url = 'https://api.openai.com/v1/models'
    headers = {authorization: 'Bearer ' + apiKey}
  } else if (provider === 'openrouter') {
    url = 'https://openrouter.ai/api/v1/key'
    headers = {authorization: 'Bearer ' + apiKey}
  } else {
    url =
      'https://generativelanguage.googleapis.com/v1beta/models?key=' +
      encodeURIComponent(apiKey) +
      '&pageSize=1'
  }

  let response
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers: headers,
      signal: AbortSignal.timeout(10000),
    })
  } catch (error) {
    let reason = 'the provider did not answer'
    if (error instanceof Error) reason = error.message

    return {status: 'unreachable', reason: reason}
  }

  if (response.ok) return {status: 'ok', reason: ''}

  if (response.status === 401 || response.status === 403) {
    return {status: 'rejected', reason: provider + ' did not accept that key.'}
  }

  return {status: 'unreachable', reason: provider + ' answered ' + response.status + '.'}
}

class MockProvider implements RawAIProvider {
  readonly name: ProviderName = 'mock'
  readonly model = 'mock'
  readonly answeringModel = 'mock'
  readonly supportsVision = true
  readonly executionSite: ExecutionSite = 'server'

  async extractQuestions(page: PageInput): Promise<unknown> {
    let numbered = []

    for (let raw of page.text.split('\n')) {
      let line = raw.trim()
      if (!/^\s*\d+[.)]\s+/.test(line)) continue

      numbered.push(line)
      if (numbered.length === 40) break
    }

    if (numbered.length === 0) {
      let width = page.width
      if (width > 100) width = 100

      let height = page.height
      if (height > 100) height = 100

      return {
        questions: [
          {
            ordinal: 1,
            prompt_text: 'Sample question from page ' + page.pageNumber,
            question_type: 'multiple_choice',
            choices: [
              {label: 'A', text: 'First option'},
              {label: 'B', text: 'Second option'},
            ],
            bbox: [0, 0, width, height],
            has_figure: false,
          },
        ],
      }
    }

    let questions = []

    for (let index = 0; index < numbered.length; index++) {
      questions.push({
        ordinal: index + 1,
        prompt_text: numbered[index].replace(/^\s*\d+[.)]\s+/, ''),
        question_type: 'multiple_choice',
        choices: [
          {label: 'A', text: 'Option A'},
          {label: 'B', text: 'Option B'},
          {label: 'C', text: 'Option C'},
          {label: 'D', text: 'Option D'},
        ],
        bbox: null,
        has_figure: false,
      })
    }

    return {questions: questions}
  }

  async extractPages(pages: PageInput[]): Promise<unknown> {
    const questions: unknown[] = []

    for (let index = 0; index < pages.length; index++) {
      const raw = (await this.extractQuestions(pages[index])) as {questions?: unknown}
      if (!raw || !Array.isArray(raw.questions)) continue

      for (const item of raw.questions) {
        if (!item || typeof item !== 'object') continue

        const source = item as Record<string, unknown>
        const row: Record<string, unknown> = {image_index: index + 1}

        for (const key of Object.keys(source)) row[key] = source[key]

        questions.push(row)
      }
    }

    return {questions: questions}
  }

  async classifyTopic(promptText: string, candidates: TopicCandidate[]): Promise<unknown> {
    if (candidates.length === 0) {
      return {topic_slug: null, confidence: 0, abstain: true}
    }

    let words = new Set<string>()
    for (let word of promptText.toLowerCase().split(/[^a-z0-9]+/)) {
      if (word.length > 3) words.add(word)
    }

    let best = candidates[0]
    let bestScore = -1

    for (let candidate of candidates) {
      let score = 0

      for (let word of candidate.name.toLowerCase().split(/[^a-z0-9]+/)) {
        if (words.has(word)) score = score + 1
      }

      if (score > bestScore) {
        best = candidate
        bestScore = score
      }
    }

    if (bestScore <= 0) {
      return {topic_slug: null, confidence: 0.1, abstain: true}
    }

    let confidence = 0.5 + bestScore * 0.15
    if (confidence > 0.95) confidence = 0.95

    return {topic_slug: best.slug, confidence: confidence, abstain: false}
  }

  async classifyBatch(inputs: ClassifyBatchInput[]): Promise<unknown> {
    const classifications: unknown[] = []

    for (const input of inputs) {
      const raw = (await this.classifyTopic(input.promptText, input.candidates)) as Record<
        string,
        unknown
      >

      const row: Record<string, unknown> = {index: input.index}
      for (const key of Object.keys(raw)) row[key] = raw[key]

      classifications.push(row)
    }

    return {classifications: classifications}
  }

  async answerQuestion(input: AnswerInput): Promise<unknown> {
    let answer = '42'
    if (input.choices.length > 0) answer = input.choices[0].label

    let traps = []
    for (let i = 1; i < input.choices.length; i++) {
      traps.push({
        label: input.choices[i].label,
        why: 'Mock trap for ' + input.choices[i].label + '.',
      })
    }

    return {
      answer: answer,
      working: 'Mock working for: ' + input.promptText.slice(0, 60),
      traps: traps,
      confidence: 0.9,
    }
  }

  async answerBatch(inputs: BatchAnswerInput[]): Promise<unknown> {
    const solutions: unknown[] = []

    for (const input of inputs) {
      const raw = (await this.answerQuestion({
        promptText: input.promptText,
        choices: input.choices,
      })) as Record<string, unknown>

      const row: Record<string, unknown> = {ordinal: input.ordinal}
      for (const key of Object.keys(raw)) row[key] = raw[key]

      solutions.push(row)
    }

    return {solutions: solutions}
  }

  async teachTopic(input: LessonInput): Promise<unknown> {
    return {
      body_md: '## ' + input.topicName + '\n\nMock lesson for ' + input.topicPath + '.',
      examples: [
        {question: 'Mock example one', working: 'Step one.', answer: '1'},
        {question: 'Mock example two', working: 'Step one.', answer: '2'},
      ],
      common_errors: [{mistake: 'Mock mistake', why: 'Mock reason', fix: 'Mock fix'}],
    }
  }

  async writePractice(input: PracticeInput): Promise<unknown> {
    let wanted = input.count
    if (wanted < 1) wanted = 1
    if (wanted > 10) wanted = 10

    let questions = []

    for (let index = 0; index < wanted; index++) {
      let first = index + 2
      let second = index + 3

      questions.push({
        prompt_text:
          'A shelf holds ' +
          first +
          ' boxes and each box holds ' +
          second +
          ' pens. How many pens are on the shelf?',
        choices: [
          {label: 'A', text: String(first * second)},
          {label: 'B', text: String(first + second)},
          {label: 'C', text: String(first * second - first)},
          {label: 'D', text: String(first * second + second)},
        ],
        correct_label: 'A',
        working:
          'Multiply the number of boxes by the pens in each box: ' +
          first +
          ' x ' +
          second +
          ' = ' +
          first * second +
          '.',
      })
    }

    return {questions: questions}
  }

  async explain(input: ExplainInput): Promise<unknown> {
    const chosen = input.studentAnswer

    let correct = 'not recorded'
    if (input.correctAnswer) correct = input.correctAnswer

    if (!chosen) {
      return {
        body_md: 'The correct answer is **' + correct + '**.',
        misconception_note: null,
      }
    }

    return {
      body_md:
        'You answered **' +
        chosen +
        '**, but the correct answer is **' +
        correct +
        '**. Work back through the question and check which step produced ' +
        chosen +
        ' instead.',
      misconception_note: 'Chose ' + chosen + ' instead of ' + correct + '.',
    }
  }
}

class NullProvider implements RawAIProvider {
  readonly name: ProviderName = 'null'
  readonly model = 'none'
  readonly answeringModel = 'none'
  readonly supportsVision = false
  readonly executionSite: ExecutionSite = 'none'

  async extractQuestions(_page: PageInput): Promise<unknown> {
    throw new ProviderUnavailable()
  }

  async extractPages(_pages: PageInput[]): Promise<unknown> {
    throw new ProviderUnavailable()
  }

  async classifyTopic(
    _promptText: string,
    _candidates: TopicCandidate[],
  ): Promise<unknown> {
    throw new ProviderUnavailable()
  }

  async classifyBatch(_inputs: ClassifyBatchInput[]): Promise<unknown> {
    throw new ProviderUnavailable()
  }

  async answerQuestion(_input: AnswerInput): Promise<unknown> {
    throw new ProviderUnavailable()
  }

  async answerBatch(_inputs: BatchAnswerInput[]): Promise<unknown> {
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
