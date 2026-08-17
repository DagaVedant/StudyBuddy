CREATE TYPE "public"."content_origin" AS ENUM('extracted', 'generated');--> statement-breakpoint
ALTER TYPE "public"."source_type" ADD VALUE 'generated';--> statement-breakpoint
ALTER TYPE "public"."usage_kind" ADD VALUE 'generate_practice';--> statement-breakpoint
ALTER TABLE "questions" ADD COLUMN "origin" "content_origin" DEFAULT 'extracted' NOT NULL;--> statement-breakpoint
ALTER TABLE "worksheets" ADD COLUMN "origin" "content_origin" DEFAULT 'extracted' NOT NULL;--> statement-breakpoint
CREATE INDEX "questions_user_origin_idx" ON "questions" USING btree ("user_id","origin");--> statement-breakpoint
CREATE UNIQUE INDEX "worksheets_user_generated" ON "worksheets" USING btree ("user_id") WHERE "worksheets"."origin" = 'generated';