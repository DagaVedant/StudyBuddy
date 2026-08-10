-- One markup attempt per question per student.
--
-- Marking a worksheet twice wrote a second attempt for every question on it and
-- pushed every review card forward on answers nobody gave, which corrupts the
-- denominator the whole weakness report is built on. The route checked first,
-- but a read followed by an insert is not a guarantee.
--
-- Partial, on `markup` only. A review attempt is supposed to repeat, once per
-- sitting, forever, so a plain unique on (user, question, source) would make the
-- second review of any question fail.
--
-- The delete runs first because CREATE UNIQUE INDEX aborts outright on a table
-- that already holds duplicates, and taking every pending migration down with it
-- is a bad way to find that out. Production had none when this was written; a
-- database that has been running the old code longer may. The earliest row
-- survives, which is the answer the student actually gave: the later ones are
-- the double-submit.
DELETE FROM "attempts" a
USING "attempts" b
WHERE a."source" = 'markup'
  AND b."source" = 'markup'
  AND a."user_id" = b."user_id"
  AND a."question_id" = b."question_id"
  AND (a."created_at", a."id") > (b."created_at", b."id");
--> statement-breakpoint
CREATE UNIQUE INDEX "attempts_markup_once" ON "attempts" USING btree ("user_id","question_id") WHERE "attempts"."source" = 'markup';
