CREATE INDEX "accounts_user_idx" ON "accounts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "attempts_question_idx" ON "attempts" USING btree ("question_id");--> statement-breakpoint
CREATE INDEX "attempts_choice_idx" ON "attempts" USING btree ("selected_choice_id");--> statement-breakpoint
CREATE INDEX "explanations_attempt_idx" ON "explanations" USING btree ("attempt_id");--> statement-breakpoint
CREATE INDEX "processing_jobs_claimed_by_idx" ON "processing_jobs" USING btree ("claimed_by");--> statement-breakpoint
CREATE INDEX "questions_page_idx" ON "questions" USING btree ("page_id");--> statement-breakpoint
CREATE INDEX "reports_user_idx" ON "reports" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "reports_question_idx" ON "reports" USING btree ("question_id");--> statement-breakpoint
CREATE INDEX "reports_explanation_idx" ON "reports" USING btree ("explanation_id");--> statement-breakpoint
CREATE INDEX "review_cards_question_idx" ON "review_cards" USING btree ("question_id");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "topic_proposals_source_question_idx" ON "topic_proposals" USING btree ("source_question_id");--> statement-breakpoint
CREATE INDEX "topic_proposals_user_idx" ON "topic_proposals" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "topic_proposals_suggested_parent_idx" ON "topic_proposals" USING btree ("suggested_parent_id");--> statement-breakpoint
CREATE INDEX "topic_proposals_merged_into_idx" ON "topic_proposals" USING btree ("merged_into_topic_id");--> statement-breakpoint
CREATE INDEX "usage_events_job_idx" ON "usage_events" USING btree ("job_id");