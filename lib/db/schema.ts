import { sql } from 'drizzle-orm'
import type { AnyPgColumn } from 'drizzle-orm/pg-core'
import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  unique,
  uniqueIndex,
  vector,
} from 'drizzle-orm/pg-core'
import type { AdapterAccountType } from 'next-auth/adapters'

export type BBox = [number, number, number, number]

export interface TextLine {
  text: string
  bbox: BBox
}

const id = () =>
  text('id')
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID())

const createdAt = () => timestamp('created_at', { withTimezone: true }).defaultNow().notNull()

export const userRole = pgEnum('user_role', ['student', 'admin'])

export const aiTier = pgEnum('ai_tier', ['trial', 'free', 'cloud', 'ollama'])

export const aiProvider = pgEnum('ai_provider', [
  'anthropic',
  'openai',
  'openrouter',
  'google',
  'ollama',
])

export const sourceType = pgEnum('source_type', [
  'pdf_digital',
  'pdf_scanned',
  'photo',
  'image',
  'generated',
])

export const contentOrigin = pgEnum('content_origin', ['extracted', 'generated'])

export const worksheetStatus = pgEnum('worksheet_status', [
  'uploading',
  'queued',
  'processing',
  'awaiting_review',
  'ready',
  'failed',
])

export const questionType = pgEnum('question_type', [
  'multiple_choice',
  'free_response',
  'true_false',
  'fill_blank',
  'grid_in',
])

export const answerSource = pgEnum('answer_source', [
  'user_key',
  'pdf_key',
  'ai_derived',
  'none',
])

export const ocrEngine = pgEnum('ocr_engine', ['pdf_text', 'tesseract', 'vision'])

export const assignedBy = pgEnum('assigned_by', ['ai', 'user'])

export const proposalStatus = pgEnum('proposal_status', [
  'pending',
  'merged',
  'accepted',
  'rejected',
])

export const attemptOutcome = pgEnum('attempt_outcome', ['correct', 'unsure', 'wrong'])

export const attemptSource = pgEnum('attempt_source', ['markup', 'review'])

export const jobExecutor = pgEnum('job_executor', ['server', 'browser', 'operator_gpu'])

export const jobStatus = pgEnum('job_status', [
  'pending',
  'claimed',
  'running',
  'completed',
  'failed',
  'cancelled',
])

export const jobPriority = pgEnum('job_priority', ['high', 'normal', 'low'])

export const jobStage = pgEnum('job_stage', [
  'extract',
  'answer_key',
  'classify',
  'explain',
])

export const workerStatus = pgEnum('worker_status', ['online', 'offline', 'draining'])

export const reportKind = pgEnum('report_kind', ['worksheet', 'explanation'])

export const cardState = pgEnum('card_state', ['new', 'learning', 'review', 'relearning'])

export const usageKind = pgEnum('usage_kind', [
  'extract_page',
  'answer_derive',
  'classify',
  'explain',
  'generate_practice',
])

export const users = pgTable('users', {
  id: id(),
  name: text('name'),
  email: text('email').unique().notNull(),

  username: text('username').unique(),

  emailVerified: timestamp('email_verified', { withTimezone: true }),
  image: text('image'),

  passwordHash: text('password_hash'),

  dob: timestamp('dob', { withTimezone: true }),

  role: userRole('role').default('student').notNull(),

  trialWorksheetsUsed: integer('trial_worksheets_used').default(0).notNull(),
  trialExplanationsUsed: integer('trial_explanations_used').default(0).notNull(),

  createdAt: createdAt(),
})

export const accounts = pgTable(
  'accounts',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: text('type').$type<AdapterAccountType>().notNull(),
    provider: text('provider').notNull(),
    providerAccountId: text('provider_account_id').notNull(),
    refresh_token: text('refresh_token'),
    access_token: text('access_token'),
    expires_at: integer('expires_at'),
    token_type: text('token_type'),
    scope: text('scope'),
    id_token: text('id_token'),
    session_state: text('session_state'),
  },
  (t) => [
    primaryKey({ columns: [t.provider, t.providerAccountId] }),
    index('accounts_user_idx').on(t.userId),
  ],
)

export const sessions = pgTable(
  'sessions',
  {
    sessionToken: text('session_token').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expires: timestamp('expires', { withTimezone: true }).notNull(),
  },
  (t) => [index('sessions_user_idx').on(t.userId)],
)

export const verificationTokens = pgTable(
  'verification_tokens',
  {
    identifier: text('identifier').notNull(),
    token: text('token').notNull(),
    expires: timestamp('expires', { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.identifier, t.token] })],
)

export const passwordResetTokens = pgTable(
  'password_reset_tokens',
  {
    id: id(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    tokenHash: text('token_hash').notNull().unique(),

    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),

    createdAt: createdAt(),
  },
  (t) => [index('password_reset_tokens_user_idx').on(t.userId)],
)

export const userAiCredentials = pgTable(
  'user_ai_credentials',
  {
    id: id(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: aiProvider('provider').notNull(),

    encryptedKey: text('encrypted_key'),
    keyIv: text('key_iv'),
    keyAuthTag: text('key_auth_tag'),

    keyLast4: text('key_last4'),

    ollamaBaseUrl: text('ollama_base_url'),

    modelName: text('model_name'),
    visionModelName: text('vision_model_name'),

    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [unique('user_ai_credentials_user_provider').on(t.userId, t.provider)],
)

export const worksheets = pgTable(
  'worksheets',
  {
    id: id(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    sourceType: sourceType('source_type').notNull(),
    origin: contentOrigin('origin').default('extracted').notNull(),
    pageCount: integer('page_count').default(0).notNull(),

    subjectHint: text('subject_hint'),

    expectedQuestionCount: integer('expected_question_count'),
    status: worksheetStatus('status').default('uploading').notNull(),

    tierUsed: aiTier('tier_used'),

    classificationError: text('classification_error'),

    createdAt: createdAt(),
  },
  (t) => [
    index('worksheets_user_created_idx').on(t.userId, t.createdAt),
    uniqueIndex('worksheets_user_generated')
      .on(t.userId)
      .where(sql`${t.origin} = 'generated'`),
  ],
)

export const worksheetPages = pgTable(
  'worksheet_pages',
  {
    id: id(),
    worksheetId: text('worksheet_id')
      .notNull()
      .references(() => worksheets.id, { onDelete: 'cascade' }),
    pageNumber: integer('page_number').notNull(),

    imageKey: text('image_key').notNull(),
    width: integer('width'),
    height: integer('height'),
    ocrText: text('ocr_text'),
    ocrEngine: ocrEngine('ocr_engine'),

    textLines: jsonb('text_lines').$type<TextLine[]>(),
  },
  (t) => [unique('worksheet_pages_number').on(t.worksheetId, t.pageNumber)],
)

export const questions = pgTable(
  'questions',
  {
    id: id(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    worksheetId: text('worksheet_id')
      .notNull()
      .references(() => worksheets.id, { onDelete: 'cascade' }),
    pageId: text('page_id').references(() => worksheetPages.id, { onDelete: 'set null' }),
    ordinal: integer('ordinal').notNull(),

    printedNumber: integer('printed_number'),

    promptText: text('prompt_text').notNull(),
    questionType: questionType('question_type').notNull(),

    origin: contentOrigin('origin').default('extracted').notNull(),

    bbox: jsonb('bbox').$type<BBox | null>(),

    correctAnswer: text('correct_answer'),
    answerSource: answerSource('answer_source').default('none').notNull(),

    extractionConfidence: real('extraction_confidence'),

    userVerified: boolean('user_verified').default(false).notNull(),

    contentHash: text('content_hash'),
    embedding: vector('embedding', { dimensions: 384 }),

    createdAt: createdAt(),
  },
  (t) => [
    index('questions_user_idx').on(t.userId),
    index('questions_worksheet_idx').on(t.worksheetId),
    index('questions_page_idx').on(t.pageId),
    index('questions_content_hash_idx').on(t.userId, t.contentHash),
    index('questions_user_origin_idx').on(t.userId, t.origin),
    index('questions_embedding_idx').using(
      'hnsw',
      t.embedding.op('vector_cosine_ops'),
    ),
  ],
)

export const answerChoices = pgTable(
  'answer_choices',
  {
    id: id(),
    questionId: text('question_id')
      .notNull()
      .references(() => questions.id, { onDelete: 'cascade' }),
    label: text('label').notNull(),
    text: text('text').notNull(),
    isCorrect: boolean('is_correct').default(false).notNull(),
  },
  (t) => [index('answer_choices_question_idx').on(t.questionId)],
)

export const topics = pgTable(
  'topics',
  {
    id: id(),

    parentId: text('parent_id').references((): AnyPgColumn => topics.id, {
      onDelete: 'cascade',
    }),
    slug: text('slug').notNull().unique(),
    name: text('name').notNull(),
    depth: integer('depth').default(0).notNull(),

    subjectRoot: text('subject_root').notNull(),

    isCanonical: boolean('is_canonical').default(true).notNull(),
    isLeaf: boolean('is_leaf').default(false).notNull(),
    embedding: vector('embedding', { dimensions: 384 }),
    createdAt: createdAt(),
  },
  (t) => [
    index('topics_parent_idx').on(t.parentId),
    index('topics_subject_root_idx').on(t.subjectRoot),
    index('topics_embedding_idx').using('hnsw', t.embedding.op('vector_cosine_ops')),
  ],
)

export const questionTopics = pgTable(
  'question_topics',
  {
    questionId: text('question_id')
      .notNull()
      .references(() => questions.id, { onDelete: 'cascade' }),
    topicId: text('topic_id')
      .notNull()
      .references(() => topics.id, { onDelete: 'cascade' }),
    confidence: real('confidence'),
    assignedBy: assignedBy('assigned_by').notNull(),
    isPrimary: boolean('is_primary').default(true).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.questionId, t.topicId] }),
    index('question_topics_topic_idx').on(t.topicId),
  ],
)

export const topicProposals = pgTable(
  'topic_proposals',
  {
    id: id(),
    proposedName: text('proposed_name').notNull(),
    suggestedParentId: text('suggested_parent_id').references(() => topics.id, {
      onDelete: 'set null',
    }),
    sourceQuestionId: text('source_question_id').references(() => questions.id, {
      onDelete: 'cascade',
    }),
    userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
    embedding: vector('embedding', { dimensions: 384 }),
    status: proposalStatus('status').default('pending').notNull(),
    mergedIntoTopicId: text('merged_into_topic_id').references(() => topics.id, {
      onDelete: 'set null',
    }),
    createdAt: createdAt(),
  },
  (t) => [
    index('topic_proposals_status_idx').on(t.status),
    index('topic_proposals_source_question_idx').on(t.sourceQuestionId),
    index('topic_proposals_user_idx').on(t.userId),
    index('topic_proposals_suggested_parent_idx').on(t.suggestedParentId),
    index('topic_proposals_merged_into_idx').on(t.mergedIntoTopicId),
    index('topic_proposals_embedding_idx').using(
      'hnsw',
      t.embedding.op('vector_cosine_ops'),
    ),
  ],
)

export const attempts = pgTable(
  'attempts',
  {
    id: id(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    questionId: text('question_id')
      .notNull()
      .references(() => questions.id, { onDelete: 'cascade' }),
    outcome: attemptOutcome('outcome').notNull(),

    selectedChoiceId: text('selected_choice_id').references(() => answerChoices.id, {
      onDelete: 'set null',
    }),
    freeTextAnswer: text('free_text_answer'),
    source: attemptSource('source').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('attempts_markup_once')
      .on(t.userId, t.questionId)
      .where(sql`${t.source} = 'markup'`),

    index('attempts_user_question_idx').on(t.userId, t.questionId),
    index('attempts_user_created_idx').on(t.userId, t.createdAt),
    index('attempts_question_idx').on(t.questionId),
    index('attempts_choice_idx').on(t.selectedChoiceId),
  ],
)

export const explanations = pgTable(
  'explanations',
  {
    id: id(),
    questionId: text('question_id')
      .notNull()
      .references(() => questions.id, { onDelete: 'cascade' }),

    attemptId: text('attempt_id').references(() => attempts.id, { onDelete: 'set null' }),
    bodyMd: text('body_md').notNull(),
    misconceptionNote: text('misconception_note'),
    provider: aiProvider('provider'),
    model: text('model'),
    reportedWrong: boolean('reported_wrong').default(false).notNull(),
    generatedAt: createdAt(),
  },
  (t) => [
    index('explanations_question_idx').on(t.questionId),
    index('explanations_attempt_idx').on(t.attemptId),
  ],
)

export const questionSolutions = pgTable(
  'question_solutions',
  {
    id: id(),
    questionId: text('question_id')
      .notNull()
      .references(() => questions.id, { onDelete: 'cascade' })
      .unique(),

    derivedAnswer: text('derived_answer'),
    workingMd: text('working_md').notNull(),
    traps: jsonb('traps').$type<{ label: string | null; why: string }[]>(),
    confidence: real('confidence'),

    provider: aiProvider('provider'),
    model: text('model'),
    generatedAt: createdAt(),
  },
  (t) => [index('question_solutions_question_idx').on(t.questionId)],
)

export const topicLessons = pgTable(
  'topic_lessons',
  {
    id: id(),
    topicId: text('topic_id')
      .notNull()
      .references(() => topics.id, { onDelete: 'cascade' }),
    userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),

    bodyMd: text('body_md').notNull(),
    examples: jsonb('examples').$type<
      { question: string; working: string; answer: string }[]
    >(),
    commonErrors: jsonb('common_errors').$type<
      { mistake: string; why: string; fix: string }[]
    >(),

    provider: aiProvider('provider'),
    model: text('model'),
    generatedAt: createdAt(),
  },
  (t) => [
    uniqueIndex('topic_lessons_canonical_once')
      .on(t.topicId)
      .where(sql`${t.userId} is null`),

    uniqueIndex('topic_lessons_per_user_once')
      .on(t.topicId, t.userId)
      .where(sql`${t.userId} is not null`),

    index('topic_lessons_topic_idx').on(t.topicId),
    index('topic_lessons_user_idx').on(t.userId),
  ],
)

export const reports = pgTable(
  'reports',
  {
    id: id(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    kind: reportKind('kind').notNull(),

    worksheetId: text('worksheet_id').references(() => worksheets.id, {
      onDelete: 'cascade',
    }),
    questionId: text('question_id').references(() => questions.id, {
      onDelete: 'cascade',
    }),
    explanationId: text('explanation_id').references(() => explanations.id, {
      onDelete: 'cascade',
    }),

    message: text('message'),

    createdAt: createdAt(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  },
  (t) => [
    index('reports_created_idx').on(t.createdAt),
    index('reports_worksheet_idx').on(t.worksheetId),
    index('reports_user_idx').on(t.userId),
    index('reports_question_idx').on(t.questionId),
    index('reports_explanation_idx').on(t.explanationId),
  ],
)

export const reviewCards = pgTable(
  'review_cards',
  {
    id: id(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    questionId: text('question_id')
      .notNull()
      .references(() => questions.id, { onDelete: 'cascade' }),

    dueAt: timestamp('due_at', { withTimezone: true }).notNull(),
    stability: real('stability').default(0).notNull(),
    difficulty: real('difficulty').default(0).notNull(),
    elapsedDays: integer('elapsed_days').default(0).notNull(),
    scheduledDays: integer('scheduled_days').default(0).notNull(),

    learningSteps: integer('learning_steps').default(0).notNull(),
    reps: integer('reps').default(0).notNull(),
    lapses: integer('lapses').default(0).notNull(),
    state: cardState('state').default('new').notNull(),
    lastReview: timestamp('last_review', { withTimezone: true }),

    retiredAt: timestamp('retired_at', { withTimezone: true }),

    createdAt: createdAt(),
  },
  (t) => [
    unique('review_cards_user_question').on(t.userId, t.questionId),

    index('review_cards_user_due_idx').on(t.userId, t.dueAt),
    index('review_cards_question_idx').on(t.questionId),
  ],
)

export const reviewLogs = pgTable(
  'review_logs',
  {
    id: id(),
    cardId: text('card_id')
      .notNull()
      .references(() => reviewCards.id, { onDelete: 'cascade' }),
    rating: integer('rating').notNull(),
    state: cardState('state').notNull(),
    elapsedDays: integer('elapsed_days').default(0).notNull(),
    scheduledDays: integer('scheduled_days').default(0).notNull(),
    reviewedAt: createdAt(),
  },
  (t) => [index('review_logs_card_idx').on(t.cardId)],
)

export const processingJobs = pgTable(
  'processing_jobs',
  {
    id: id(),
    worksheetId: text('worksheet_id')
      .notNull()
      .references(() => worksheets.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    stage: jobStage('stage').notNull(),
    status: jobStatus('status').default('pending').notNull(),
    executor: jobExecutor('executor').notNull(),
    priority: jobPriority('priority').default('normal').notNull(),
    progress: real('progress').default(0).notNull(),

    claimedBy: text('claimed_by').references(() => gpuWorkers.id, { onDelete: 'set null' }),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    attemptCount: integer('attempt_count').default(0).notNull(),

    error: text('error'),

    checkpoint: jsonb('checkpoint').$type<Record<string, unknown>>(),

    createdAt: createdAt(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => [
    index('processing_jobs_claim_idx').on(t.status, t.executor, t.priority, t.createdAt),
    index('processing_jobs_worksheet_idx').on(t.worksheetId),
    index('processing_jobs_user_idx').on(t.userId),
    index('processing_jobs_claimed_by_idx').on(t.claimedBy),
  ],
)

export const gpuWorkers = pgTable('gpu_workers', {
  id: id(),
  name: text('name').notNull().unique(),
  modelName: text('model_name'),
  status: workerStatus('status').default('offline').notNull(),
  jobsInFlight: integer('jobs_in_flight').default(0).notNull(),
  lastHeartbeatAt: timestamp('last_heartbeat_at', { withTimezone: true }),
  createdAt: createdAt(),
})

export const usageEvents = pgTable(
  'usage_events',
  {
    id: id(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: usageKind('kind').notNull(),
    provider: aiProvider('provider'),
    tierUsed: aiTier('tier_used'),
    quantity: integer('quantity').default(1).notNull(),
    tokensIn: integer('tokens_in'),
    tokensOut: integer('tokens_out'),

    refunded: boolean('refunded').default(false).notNull(),
    jobId: text('job_id').references(() => processingJobs.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [
    index('usage_events_user_kind_idx').on(t.userId, t.kind, t.createdAt),
    index('usage_events_job_idx').on(t.jobId),
  ],
)

export const rateLimits = pgTable('rate_limits', {
  key: text('key').primaryKey(),
  count: integer('count').default(0).notNull(),
  windowStart: timestamp('window_start', { withTimezone: true }).defaultNow().notNull(),
})

export const notificationKind = pgEnum('notification_kind', [
  'worksheet_ready',
  'worksheet_failed',
])

export const notifications = pgTable(
  'notifications',
  {
    id: id(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: notificationKind('kind').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    href: text('href').notNull(),
    readAt: timestamp('read_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    index('notifications_user_created_idx').on(t.userId, t.createdAt),
  ],
)

export const pushSubscriptions = pgTable(
  'push_subscriptions',
  {
    id: id(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    endpoint: text('endpoint').notNull().unique(),
    p256dh: text('p256dh').notNull(),
    auth: text('auth').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('push_subscriptions_user_idx').on(t.userId)],
)

export type User = typeof users.$inferSelect
export type Notification = typeof notifications.$inferSelect
export type PushSubscription = typeof pushSubscriptions.$inferSelect
export type Worksheet = typeof worksheets.$inferSelect
export type WorksheetPage = typeof worksheetPages.$inferSelect
export type Question = typeof questions.$inferSelect
export type AnswerChoice = typeof answerChoices.$inferSelect
export type Topic = typeof topics.$inferSelect
export type TopicProposal = typeof topicProposals.$inferSelect
export type Attempt = typeof attempts.$inferSelect
export type Explanation = typeof explanations.$inferSelect
export type ReviewCard = typeof reviewCards.$inferSelect
export type ProcessingJob = typeof processingJobs.$inferSelect
export type GpuWorker = typeof gpuWorkers.$inferSelect
export type UsageEvent = typeof usageEvents.$inferSelect
export type UserAiCredential = typeof userAiCredentials.$inferSelect
