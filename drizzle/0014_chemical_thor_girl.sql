ALTER TABLE "topic_lessons" DROP CONSTRAINT "topic_lessons_topic_id_unique";--> statement-breakpoint
ALTER TABLE "topic_lessons" ADD COLUMN "user_id" text;--> statement-breakpoint
ALTER TABLE "topic_lessons" ADD CONSTRAINT "topic_lessons_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "topic_lessons_canonical_once" ON "topic_lessons" USING btree ("topic_id") WHERE "topic_lessons"."user_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "topic_lessons_per_user_once" ON "topic_lessons" USING btree ("topic_id","user_id") WHERE "topic_lessons"."user_id" is not null;--> statement-breakpoint
CREATE INDEX "topic_lessons_user_idx" ON "topic_lessons" USING btree ("user_id");