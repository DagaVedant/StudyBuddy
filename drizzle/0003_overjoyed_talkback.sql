ALTER TYPE "public"."ai_provider" ADD VALUE IF NOT EXISTS 'openrouter' BEFORE 'ollama';--> statement-breakpoint
ALTER TYPE "public"."ai_provider" ADD VALUE IF NOT EXISTS 'google' BEFORE 'ollama';
