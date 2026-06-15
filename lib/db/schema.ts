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
  vector,
} from 'drizzle-orm/pg-core'
import type { AdapterAccountType } from 'next-auth/adapters'

/** [x0, y0, x1, y1] in page-image pixels. */
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

/* -------------------------------------------------------------------------- */
/* Enums                                                                       */
/* -------------------------------------------------------------------------- */

export const userRole = pgEnum('user_role', ['student', 'admin'])

/** Which AI path the account is currently on (spec §3). */
export const aiTier = pgEnum('ai_tier', ['trial', 'free', 'cloud', 'ollama'])

export const aiProvider = pgEnum('ai_provider', ['anthropic', 'openai', 'ollama'])

export const sourceType = pgEnum('source_type', [
  'pdf_digital',
  'pdf_scanned',
  'photo',
  'image',
])

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

/** Provenance of the correct answer (spec §4 stage 4). Drives the UI badge. */
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

/** Outcome of marking up a worksheet (spec §5.3). `unsure` is deliberately
 *  distinct from `correct` — it's a leading indicator of a weak topic. */
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

/** Admin bulk uploads default to `low` so they can't stall trial users (spec §2.1). */
export const jobPriority = pgEnum('job_priority', ['high', 'normal', 'low'])

export const jobStage = pgEnum('job_stage', [
  'extract',
  'answer_key',
  'classify',
  'explain',
])

export const workerStatus = pgEnum('worker_status', ['online', 'offline', 'draining'])

/** FSRS card states, matching ts-fsrs State enum ordering. */
export const cardState = pgEnum('card_state', ['new', 'learning', 'review', 'relearning'])

export const usageKind = pgEnum('usage_kind', [
  'extract_page',
  'answer_derive',
  'classify',
  'explain',
])

/* -------------------------------------------------------------------------- */
/* Auth.js core tables                                                         */
/* -------------------------------------------------------------------------- */

export const users = pgTable('users', {
  id: id(),
  name: text('name'),
  email: text('email').unique().notNull(),
  emailVerified: timestamp('email_verified', { withTimezone: true }),
  image: text('image'),

  /** Credentials provider only; null for OAuth-only accounts. */
  passwordHash: text('password_hash'),

  /** 13+ age gate (spec §2). Stored to prove the gate was applied. */
  dob: timestamp('dob', { withTimezone: true }),

  /** Derived from ADMIN_EMAILS at login — never settable through the UI. */
  role: userRole('role').default('student').notNull(),

  aiTier: aiTier('ai_tier').default('trial').notNull(),

  /** Lifetime trial allowance (spec §3.1), not monthly. */
  trialPagesUsed: integer('trial_pages_used').default(0).notNull(),
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
  (t) => [primaryKey({ columns: [t.provider, t.providerAccountId] })],
)

export const sessions = pgTable('sessions', {
  sessionToken: text('session_token').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  expires: timestamp('expires', { withTimezone: true }).notNull(),
})

export const verificationTokens = pgTable(
  'verification_tokens',
  {
    identifier: text('identifier').notNull(),
    token: text('token').notNull(),
    expires: timestamp('expires', { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.identifier, t.token] })],
)

/* -------------------------------------------------------------------------- */
/* AI credentials (spec §3.6)                                                  */
/* -------------------------------------------------------------------------- */

export const userAiCredentials = pgTable(
  'user_ai_credentials',
  {
    id: id(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: aiProvider('provider').notNull(),

    /** AES-256-GCM ciphertext. Never returned to the client after save. */
    encryptedKey: text('encrypted_key'),
    keyIv: text('key_iv'),
    keyAuthTag: text('key_auth_tag'),
    /** Display-only suffix, e.g. "…4f2a". */
    keyLast4: text('key_last4'),

    /** Ollama only — not a secret, but validated against a localhost allowlist. */
    ollamaBaseUrl: text('ollama_base_url'),

    modelName: text('model_name'),
    visionModelName: text('vision_model_name'),

    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [unique('user_ai_credentials_user_provider').on(t.userId, t.provider)],
)

/* -------------------------------------------------------------------------- */
/* Worksheets & pages                                                          */
/* -------------------------------------------------------------------------- */

export const worksheets = pgTable(
  'worksheets',
  {
    id: id(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    sourceType: sourceType('source_type').notNull(),
    pageCount: integer('page_count').default(0).notNull(),
    /** Narrows the classifier's candidate shortlist (spec §7.2). */
    subjectHint: text('subject_hint'),
    status: worksheetStatus('status').default('uploading').notNull(),
    /** Which tier processed this, for debugging quality complaints. */
    tierUsed: aiTier('tier_used'),
    createdAt: createdAt(),
  },
  (t) => [index('worksheets_user_created_idx').on(t.userId, t.createdAt)],
)

export const worksheetPages = pgTable(
  'worksheet_pages',
  {
    id: id(),
    worksheetId: text('worksheet_id')
      .notNull()
      .references(() => worksheets.id, { onDelete: 'cascade' }),
    pageNumber: integer('page_number').notNull(),
    /**
     * Opaque storage key for the browser-rasterized page image, never a public
     * URL — reads go through /api/files, which checks ownership first (spec §8).
     * The original PDF is discarded.
     */
    imageKey: text('image_key').notNull(),
    width: integer('width'),
    height: integer('height'),
    ocrText: text('ocr_text'),
    ocrEngine: ocrEngine('ocr_engine'),
    /**
     * Per-line text with page-pixel bounding boxes. Lets the manual editor
     * fill in a question's text from a drawn region instead of making the
     * student retype it.
     */
    textLines: jsonb('text_lines').$type<TextLine[]>(),
  },
  (t) => [unique('worksheet_pages_number').on(t.worksheetId, t.pageNumber)],
)

/* -------------------------------------------------------------------------- */
/* Questions                                                                   */
/* -------------------------------------------------------------------------- */

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

    promptText: text('prompt_text').notNull(),
    questionType: questionType('question_type').notNull(),

    /** [x1, y1, x2, y2] on the page image — used to crop figures for review. */
    bbox: jsonb('bbox').$type<BBox | null>(),
    figureImageKey: text('figure_image_key'),

    correctAnswer: text('correct_answer'),
    answerSource: answerSource('answer_source').default('none').notNull(),

    extractionConfidence: real('extraction_confidence'),
    /** True once the student has confirmed it in extraction review (spec §4 stage 5). */
    userVerified: boolean('user_verified').default(false).notNull(),

    /** Normalized hash for exact-duplicate detection within a user (spec §6.3). */
    contentHash: text('content_hash'),
    embedding: vector('embedding', { dimensions: 384 }),

    createdAt: createdAt(),
  },
  (t) => [
    index('questions_user_idx').on(t.userId),
    index('questions_worksheet_idx').on(t.worksheetId),
    index('questions_content_hash_idx').on(t.userId, t.contentHash),
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

/* -------------------------------------------------------------------------- */
/* Topic taxonomy (spec §7)                                                    */
/* -------------------------------------------------------------------------- */

export const topics = pgTable(
  'topics',
  {
    id: id(),
    // Self-reference needs an explicit AnyPgColumn return type to break the cycle.
    parentId: text('parent_id').references((): AnyPgColumn => topics.id, {
      onDelete: 'cascade',
    }),
    slug: text('slug').notNull().unique(),
    name: text('name').notNull(),
    depth: integer('depth').default(0).notNull(),
    /** Root subject, denormalized so dashboard rollups avoid recursive CTEs. */
    subjectRoot: text('subject_root').notNull(),
    /** Only canonical leaves are valid classification targets. */
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
    index('topic_proposals_embedding_idx').using(
      'hnsw',
      t.embedding.op('vector_cosine_ops'),
    ),
  ],
)

/* -------------------------------------------------------------------------- */
/* Attempts (spec §6.1 — every question is tracked, not just wrong ones)       */
/* -------------------------------------------------------------------------- */

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
    /** What the student actually picked — powers misconception-targeted explanations. */
    selectedChoiceId: text('selected_choice_id').references(() => answerChoices.id, {
      onDelete: 'set null',
    }),
    freeTextAnswer: text('free_text_answer'),
    source: attemptSource('source').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index('attempts_user_question_idx').on(t.userId, t.questionId),
    index('attempts_user_created_idx').on(t.userId, t.createdAt),
  ],
)

/* -------------------------------------------------------------------------- */
/* Explanations (generated on demand, cached forever — spec §4 call 4)         */
/* -------------------------------------------------------------------------- */

export const explanations = pgTable(
  'explanations',
  {
    id: id(),
    questionId: text('question_id')
      .notNull()
      .references(() => questions.id, { onDelete: 'cascade' }),
    /** The attempt this explanation was written against, if any. */
    attemptId: text('attempt_id').references(() => attempts.id, { onDelete: 'set null' }),
    bodyMd: text('body_md').notNull(),
    misconceptionNote: text('misconception_note'),
    provider: aiProvider('provider'),
    model: text('model'),
    reportedWrong: boolean('reported_wrong').default(false).notNull(),
    generatedAt: createdAt(),
  },
  (t) => [index('explanations_question_idx').on(t.questionId)],
)

/* -------------------------------------------------------------------------- */
/* FSRS review scheduling (spec §5.4)                                          */
/* -------------------------------------------------------------------------- */

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
    /** FSRS v5 tracks position within the learning steps; dropping it breaks
     *  interval continuity across reviews. */
    learningSteps: integer('learning_steps').default(0).notNull(),
    reps: integer('reps').default(0).notNull(),
    lapses: integer('lapses').default(0).notNull(),
    state: cardState('state').default('new').notNull(),
    lastReview: timestamp('last_review', { withTimezone: true }),

    createdAt: createdAt(),
  },
  (t) => [
    unique('review_cards_user_question').on(t.userId, t.questionId),
    // The review queue query: due cards for one user, soonest first.
    index('review_cards_user_due_idx').on(t.userId, t.dueAt),
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

/* -------------------------------------------------------------------------- */
/* Job queue (spec §3.3, §4)                                                   */
/* -------------------------------------------------------------------------- */

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

    /** Worker that claimed this job, via SELECT ... FOR UPDATE SKIP LOCKED. */
    claimedBy: text('claimed_by').references(() => gpuWorkers.id, { onDelete: 'set null' }),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    attemptCount: integer('attempt_count').default(0).notNull(),

    error: text('error'),
    /** Per-page progress so a closed tab or dead worker resumes, not restarts. */
    checkpoint: jsonb('checkpoint').$type<Record<string, unknown>>(),

    createdAt: createdAt(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => [
    // The worker claim query.
    index('processing_jobs_claim_idx').on(t.status, t.executor, t.priority, t.createdAt),
    index('processing_jobs_worksheet_idx').on(t.worksheetId),
    index('processing_jobs_user_idx').on(t.userId),
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

/* -------------------------------------------------------------------------- */
/* Usage accounting (trial quota enforcement — spec §3.1)                      */
/* -------------------------------------------------------------------------- */

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
    /** Set when a failed job refunds trial quota (spec §12 assumption 9). */
    refunded: boolean('refunded').default(false).notNull(),
    jobId: text('job_id').references(() => processingJobs.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [index('usage_events_user_kind_idx').on(t.userId, t.kind, t.createdAt)],
)

/* -------------------------------------------------------------------------- */
/* Inferred types                                                              */
/* -------------------------------------------------------------------------- */

export type User = typeof users.$inferSelect
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
