-- IF NOT EXISTS on both, so a replay of this file cannot abort a batch.
--
-- drizzle decides what to run by comparing the journal's timestamp against the
-- newest row in __drizzle_migrations (pg-core/dialect.js), and it runs the whole
-- pending folder inside one transaction. So this file is only ever replayed
-- after a batch that included it rolled back, and a rollback normally takes the
-- ADD VALUE with it. Normally. IF NOT EXISTS costs nothing and removes the case
-- where it did not.
--
-- Note for whoever adds the next value: a label added here cannot be USED in
-- DDL in the same transaction that adds it. Postgres will not see it until the
-- transaction commits, so a later migration in the same pending batch that
-- writes 'google' as a column default or inside a CHECK fails with "unsafe use
-- of new value". Add the label in one migration and use it in the next.
ALTER TYPE "public"."ai_provider" ADD VALUE IF NOT EXISTS 'openrouter' BEFORE 'ollama';--> statement-breakpoint
ALTER TYPE "public"."ai_provider" ADD VALUE IF NOT EXISTS 'google' BEFORE 'ollama';
