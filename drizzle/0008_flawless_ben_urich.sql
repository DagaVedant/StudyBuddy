DELETE FROM "attempts" a
USING "attempts" b
WHERE a."source" = 'markup'
  AND b."source" = 'markup'
  AND a."user_id" = b."user_id"
  AND a."question_id" = b."question_id"
  AND (a."created_at", a."id") > (b."created_at", b."id");
--> statement-breakpoint
CREATE UNIQUE INDEX "attempts_markup_once" ON "attempts" USING btree ("user_id","question_id") WHERE "attempts"."source" = 'markup';
