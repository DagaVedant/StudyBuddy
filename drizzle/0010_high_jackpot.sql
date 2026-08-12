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
CREATE TABLE "topic_lessons" (
	"id" text PRIMARY KEY NOT NULL,
	"topic_id" text NOT NULL,
	"body_md" text NOT NULL,
	"examples" jsonb,
	"common_errors" jsonb,
	"provider" "ai_provider",
	"model" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "topic_lessons_topic_id_unique" UNIQUE("topic_id")
);
--> statement-breakpoint
ALTER TABLE "question_solutions" ADD CONSTRAINT "question_solutions_question_id_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."questions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topic_lessons" ADD CONSTRAINT "topic_lessons_topic_id_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."topics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "question_solutions_question_idx" ON "question_solutions" USING btree ("question_id");--> statement-breakpoint
CREATE INDEX "topic_lessons_topic_idx" ON "topic_lessons" USING btree ("topic_id");