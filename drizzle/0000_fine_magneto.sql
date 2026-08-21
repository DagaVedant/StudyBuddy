CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE TYPE "public"."ai_provider" AS ENUM('anthropic', 'openai', 'openrouter', 'google', 'ollama');--> statement-breakpoint
CREATE TYPE "public"."ai_tier" AS ENUM('trial', 'free', 'cloud', 'ollama');--> statement-breakpoint
CREATE TYPE "public"."answer_source" AS ENUM('user_key', 'pdf_key', 'ai_derived', 'none');--> statement-breakpoint
CREATE TYPE "public"."assigned_by" AS ENUM('ai', 'user');--> statement-breakpoint
CREATE TYPE "public"."attempt_outcome" AS ENUM('correct', 'unsure', 'wrong');--> statement-breakpoint
CREATE TYPE "public"."attempt_source" AS ENUM('markup', 'review');--> statement-breakpoint
CREATE TYPE "public"."card_state" AS ENUM('new', 'learning', 'review', 'relearning');--> statement-breakpoint
CREATE TYPE "public"."content_origin" AS ENUM('extracted', 'generated');--> statement-breakpoint
CREATE TYPE "public"."job_executor" AS ENUM('server', 'browser', 'operator_gpu');--> statement-breakpoint
CREATE TYPE "public"."job_priority" AS ENUM('high', 'normal', 'low');--> statement-breakpoint
CREATE TYPE "public"."job_stage" AS ENUM('extract', 'answer_key', 'classify', 'explain');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('pending', 'claimed', 'running', 'completed', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."ocr_engine" AS ENUM('pdf_text', 'tesseract', 'vision');--> statement-breakpoint
CREATE TYPE "public"."question_type" AS ENUM('multiple_choice', 'free_response', 'true_false', 'fill_blank', 'grid_in');--> statement-breakpoint
CREATE TYPE "public"."report_kind" AS ENUM('worksheet', 'explanation');--> statement-breakpoint
CREATE TYPE "public"."source_type" AS ENUM('pdf_digital', 'pdf_scanned', 'photo', 'image', 'generated');--> statement-breakpoint
CREATE TYPE "public"."usage_kind" AS ENUM('extract_page', 'answer_derive', 'classify', 'explain', 'generate_practice');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('student', 'admin');--> statement-breakpoint
CREATE TYPE "public"."worker_status" AS ENUM('online', 'offline', 'draining');--> statement-breakpoint
CREATE TYPE "public"."worksheet_status" AS ENUM('uploading', 'queued', 'processing', 'awaiting_review', 'ready', 'failed');--> statement-breakpoint
CREATE TABLE "accounts" (
	"user_id" text NOT NULL,
	"type" text NOT NULL,
	"provider" text NOT NULL,
	"provider_account_id" text NOT NULL,
	"refresh_token" text,
	"access_token" text,
	"expires_at" integer,
	"token_type" text,
	"scope" text,
	"id_token" text,
	"session_state" text,
	CONSTRAINT "accounts_provider_provider_account_id_pk" PRIMARY KEY("provider","provider_account_id")
);
--> statement-breakpoint
CREATE TABLE "answer_choices" (
	"id" text PRIMARY KEY NOT NULL,
	"question_id" text NOT NULL,
	"label" text NOT NULL,
	"text" text NOT NULL,
	"is_correct" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "attempts" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"question_id" text NOT NULL,
	"outcome" "attempt_outcome" NOT NULL,
	"selected_choice_id" text,
	"free_text_answer" text,
	"source" "attempt_source" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "explanations" (
	"id" text PRIMARY KEY NOT NULL,
	"question_id" text NOT NULL,
	"attempt_id" text,
	"body_md" text NOT NULL,
	"misconception_note" text,
	"provider" "ai_provider",
	"model" text,
	"reported_wrong" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gpu_workers" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"model_name" text,
	"status" "worker_status" DEFAULT 'offline' NOT NULL,
	"jobs_in_flight" integer DEFAULT 0 NOT NULL,
	"last_heartbeat_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gpu_workers_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "password_reset_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "password_reset_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "processing_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"worksheet_id" text NOT NULL,
	"user_id" text NOT NULL,
	"stage" "job_stage" NOT NULL,
	"status" "job_status" DEFAULT 'pending' NOT NULL,
	"executor" "job_executor" NOT NULL,
	"priority" "job_priority" DEFAULT 'normal' NOT NULL,
	"progress" real DEFAULT 0 NOT NULL,
	"claimed_by" text,
	"claimed_at" timestamp with time zone,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"error" text,
	"checkpoint" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "question_solutions" (
	"id" text PRIMARY KEY NOT NULL,
	"question_id" text NOT NULL,
	"derived_answer" text,
	"working_md" text NOT NULL,
	"traps" jsonb,
	"confidence" real,
	"provider" "ai_provider",
	"model" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "question_solutions_question_id_unique" UNIQUE("question_id")
);
--> statement-breakpoint
CREATE TABLE "question_topics" (
	"question_id" text NOT NULL,
	"topic_id" text NOT NULL,
	"confidence" real,
	"assigned_by" "assigned_by" NOT NULL,
	"is_primary" boolean DEFAULT true NOT NULL,
	CONSTRAINT "question_topics_question_id_topic_id_pk" PRIMARY KEY("question_id","topic_id")
);
--> statement-breakpoint
CREATE TABLE "questions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"worksheet_id" text NOT NULL,
	"page_id" text,
	"ordinal" integer NOT NULL,
	"printed_number" integer,
	"prompt_text" text NOT NULL,
	"question_type" "question_type" NOT NULL,
	"origin" "content_origin" DEFAULT 'extracted' NOT NULL,
	"bbox" jsonb,
	"correct_answer" text,
	"answer_source" "answer_source" DEFAULT 'none' NOT NULL,
	"extraction_confidence" real,
	"user_verified" boolean DEFAULT false NOT NULL,
	"content_hash" text,
	"embedding" vector(384),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rate_limits" (
	"key" text PRIMARY KEY NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"window_start" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reports" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"kind" "report_kind" NOT NULL,
	"worksheet_id" text,
	"question_id" text,
	"explanation_id" text,
	"message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "review_cards" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"question_id" text NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"stability" real DEFAULT 0 NOT NULL,
	"difficulty" real DEFAULT 0 NOT NULL,
	"elapsed_days" integer DEFAULT 0 NOT NULL,
	"scheduled_days" integer DEFAULT 0 NOT NULL,
	"learning_steps" integer DEFAULT 0 NOT NULL,
	"reps" integer DEFAULT 0 NOT NULL,
	"lapses" integer DEFAULT 0 NOT NULL,
	"state" "card_state" DEFAULT 'new' NOT NULL,
	"last_review" timestamp with time zone,
	"retired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "review_cards_user_question" UNIQUE("user_id","question_id")
);
--> statement-breakpoint
CREATE TABLE "review_logs" (
	"id" text PRIMARY KEY NOT NULL,
	"card_id" text NOT NULL,
	"rating" integer NOT NULL,
	"state" "card_state" NOT NULL,
	"elapsed_days" integer DEFAULT 0 NOT NULL,
	"scheduled_days" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"session_token" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"expires" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "topic_lessons" (
	"id" text PRIMARY KEY NOT NULL,
	"topic_id" text NOT NULL,
	"user_id" text,
	"body_md" text NOT NULL,
	"examples" jsonb,
	"common_errors" jsonb,
	"provider" "ai_provider",
	"model" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "topics" (
	"id" text PRIMARY KEY NOT NULL,
	"parent_id" text,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"depth" integer DEFAULT 0 NOT NULL,
	"subject_root" text NOT NULL,
	"is_canonical" boolean DEFAULT true NOT NULL,
	"is_leaf" boolean DEFAULT false NOT NULL,
	"embedding" vector(384),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "topics_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "usage_events" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"kind" "usage_kind" NOT NULL,
	"provider" "ai_provider",
	"tier_used" "ai_tier",
	"quantity" integer DEFAULT 1 NOT NULL,
	"tokens_in" integer,
	"tokens_out" integer,
	"refunded" boolean DEFAULT false NOT NULL,
	"job_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_ai_credentials" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"provider" "ai_provider" NOT NULL,
	"encrypted_key" text,
	"key_iv" text,
	"key_auth_tag" text,
	"key_last4" text,
	"ollama_base_url" text,
	"model_name" text,
	"vision_model_name" text,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_ai_credentials_user_provider" UNIQUE("user_id","provider")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text,
	"email" text NOT NULL,
	"username" text,
	"email_verified" timestamp with time zone,
	"image" text,
	"password_hash" text,
	"dob" timestamp with time zone,
	"role" "user_role" DEFAULT 'student' NOT NULL,
	"trial_worksheets_used" integer DEFAULT 0 NOT NULL,
	"trial_explanations_used" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_username_unique" UNIQUE("username")
);
--> statement-breakpoint
CREATE TABLE "verification_tokens" (
	"identifier" text NOT NULL,
	"token" text NOT NULL,
	"expires" timestamp with time zone NOT NULL,
	CONSTRAINT "verification_tokens_identifier_token_pk" PRIMARY KEY("identifier","token")
);
--> statement-breakpoint
CREATE TABLE "worksheet_pages" (
	"id" text PRIMARY KEY NOT NULL,
	"worksheet_id" text NOT NULL,
	"page_number" integer NOT NULL,
	"image_key" text NOT NULL,
	"width" integer,
	"height" integer,
	"ocr_text" text,
	"ocr_engine" "ocr_engine",
	"text_lines" jsonb,
	CONSTRAINT "worksheet_pages_number" UNIQUE("worksheet_id","page_number")
);
--> statement-breakpoint
CREATE TABLE "worksheets" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"title" text NOT NULL,
	"source_type" "source_type" NOT NULL,
	"origin" "content_origin" DEFAULT 'extracted' NOT NULL,
	"page_count" integer DEFAULT 0 NOT NULL,
	"subject_hint" text,
	"expected_question_count" integer,
	"status" "worksheet_status" DEFAULT 'uploading' NOT NULL,
	"tier_used" "ai_tier",
	"classification_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "answer_choices" ADD CONSTRAINT "answer_choices_question_id_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."questions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attempts" ADD CONSTRAINT "attempts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attempts" ADD CONSTRAINT "attempts_question_id_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."questions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attempts" ADD CONSTRAINT "attempts_selected_choice_id_answer_choices_id_fk" FOREIGN KEY ("selected_choice_id") REFERENCES "public"."answer_choices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "explanations" ADD CONSTRAINT "explanations_question_id_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."questions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "explanations" ADD CONSTRAINT "explanations_attempt_id_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."attempts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processing_jobs" ADD CONSTRAINT "processing_jobs_worksheet_id_worksheets_id_fk" FOREIGN KEY ("worksheet_id") REFERENCES "public"."worksheets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processing_jobs" ADD CONSTRAINT "processing_jobs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processing_jobs" ADD CONSTRAINT "processing_jobs_claimed_by_gpu_workers_id_fk" FOREIGN KEY ("claimed_by") REFERENCES "public"."gpu_workers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_solutions" ADD CONSTRAINT "question_solutions_question_id_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."questions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_topics" ADD CONSTRAINT "question_topics_question_id_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."questions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_topics" ADD CONSTRAINT "question_topics_topic_id_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."topics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_worksheet_id_worksheets_id_fk" FOREIGN KEY ("worksheet_id") REFERENCES "public"."worksheets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_page_id_worksheet_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."worksheet_pages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_worksheet_id_worksheets_id_fk" FOREIGN KEY ("worksheet_id") REFERENCES "public"."worksheets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_question_id_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."questions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_explanation_id_explanations_id_fk" FOREIGN KEY ("explanation_id") REFERENCES "public"."explanations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_cards" ADD CONSTRAINT "review_cards_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_cards" ADD CONSTRAINT "review_cards_question_id_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."questions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_logs" ADD CONSTRAINT "review_logs_card_id_review_cards_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."review_cards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topic_lessons" ADD CONSTRAINT "topic_lessons_topic_id_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."topics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topic_lessons" ADD CONSTRAINT "topic_lessons_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topics" ADD CONSTRAINT "topics_parent_id_topics_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."topics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_job_id_processing_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."processing_jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_ai_credentials" ADD CONSTRAINT "user_ai_credentials_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worksheet_pages" ADD CONSTRAINT "worksheet_pages_worksheet_id_worksheets_id_fk" FOREIGN KEY ("worksheet_id") REFERENCES "public"."worksheets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worksheets" ADD CONSTRAINT "worksheets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "accounts_user_idx" ON "accounts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "answer_choices_question_idx" ON "answer_choices" USING btree ("question_id");--> statement-breakpoint
CREATE UNIQUE INDEX "attempts_markup_once" ON "attempts" USING btree ("user_id","question_id") WHERE "attempts"."source" = 'markup';--> statement-breakpoint
CREATE INDEX "attempts_user_question_idx" ON "attempts" USING btree ("user_id","question_id");--> statement-breakpoint
CREATE INDEX "attempts_user_created_idx" ON "attempts" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "attempts_question_idx" ON "attempts" USING btree ("question_id");--> statement-breakpoint
CREATE INDEX "attempts_choice_idx" ON "attempts" USING btree ("selected_choice_id");--> statement-breakpoint
CREATE INDEX "explanations_question_idx" ON "explanations" USING btree ("question_id");--> statement-breakpoint
CREATE INDEX "explanations_attempt_idx" ON "explanations" USING btree ("attempt_id");--> statement-breakpoint
CREATE INDEX "password_reset_tokens_user_idx" ON "password_reset_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "processing_jobs_claim_idx" ON "processing_jobs" USING btree ("status","executor","priority","created_at");--> statement-breakpoint
CREATE INDEX "processing_jobs_worksheet_idx" ON "processing_jobs" USING btree ("worksheet_id");--> statement-breakpoint
CREATE INDEX "processing_jobs_user_idx" ON "processing_jobs" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "processing_jobs_claimed_by_idx" ON "processing_jobs" USING btree ("claimed_by");--> statement-breakpoint
CREATE INDEX "question_solutions_question_idx" ON "question_solutions" USING btree ("question_id");--> statement-breakpoint
CREATE INDEX "question_topics_topic_idx" ON "question_topics" USING btree ("topic_id");--> statement-breakpoint
CREATE INDEX "questions_user_idx" ON "questions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "questions_worksheet_idx" ON "questions" USING btree ("worksheet_id");--> statement-breakpoint
CREATE INDEX "questions_page_idx" ON "questions" USING btree ("page_id");--> statement-breakpoint
CREATE INDEX "questions_content_hash_idx" ON "questions" USING btree ("user_id","content_hash");--> statement-breakpoint
CREATE INDEX "questions_user_origin_idx" ON "questions" USING btree ("user_id","origin");--> statement-breakpoint
CREATE INDEX "questions_embedding_idx" ON "questions" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "reports_created_idx" ON "reports" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "reports_worksheet_idx" ON "reports" USING btree ("worksheet_id");--> statement-breakpoint
CREATE INDEX "reports_user_idx" ON "reports" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "reports_question_idx" ON "reports" USING btree ("question_id");--> statement-breakpoint
CREATE INDEX "reports_explanation_idx" ON "reports" USING btree ("explanation_id");--> statement-breakpoint
CREATE INDEX "review_cards_user_due_idx" ON "review_cards" USING btree ("user_id","due_at");--> statement-breakpoint
CREATE INDEX "review_cards_question_idx" ON "review_cards" USING btree ("question_id");--> statement-breakpoint
CREATE INDEX "review_logs_card_idx" ON "review_logs" USING btree ("card_id");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "topic_lessons_canonical_once" ON "topic_lessons" USING btree ("topic_id") WHERE "topic_lessons"."user_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "topic_lessons_per_user_once" ON "topic_lessons" USING btree ("topic_id","user_id") WHERE "topic_lessons"."user_id" is not null;--> statement-breakpoint
CREATE INDEX "topic_lessons_topic_idx" ON "topic_lessons" USING btree ("topic_id");--> statement-breakpoint
CREATE INDEX "topic_lessons_user_idx" ON "topic_lessons" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "topics_parent_idx" ON "topics" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "topics_subject_root_idx" ON "topics" USING btree ("subject_root");--> statement-breakpoint
CREATE INDEX "topics_embedding_idx" ON "topics" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "usage_events_user_kind_idx" ON "usage_events" USING btree ("user_id","kind","created_at");--> statement-breakpoint
CREATE INDEX "usage_events_job_idx" ON "usage_events" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "worksheets_user_created_idx" ON "worksheets" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "worksheets_user_generated" ON "worksheets" USING btree ("user_id") WHERE "worksheets"."origin" = 'generated';