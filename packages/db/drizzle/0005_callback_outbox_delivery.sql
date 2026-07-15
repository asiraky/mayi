CREATE TYPE "public"."callback_delivery_status" AS ENUM('WAITING', 'READY', 'RUNNING', 'FAILED', 'DELIVERED', 'DEAD_LETTER');--> statement-breakpoint
ALTER TYPE "public"."job_state" ADD VALUE 'DEAD_LETTER';--> statement-breakpoint
ALTER TABLE "approval_callbacks" ADD COLUMN "delivery_status" "callback_delivery_status" DEFAULT 'WAITING' NOT NULL;--> statement-breakpoint
ALTER TABLE "approval_callbacks" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "approval_callbacks" ADD COLUMN "next_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "approval_callbacks" ADD COLUMN "lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "approval_callbacks" ADD COLUMN "last_error" text;--> statement-breakpoint
ALTER TABLE "approval_callbacks" ADD COLUMN "occurred_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "approval_callbacks" ADD COLUMN "completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "approval_callbacks" ADD COLUMN "dead_lettered_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "approval_callbacks_delivery_idx" ON "approval_callbacks" USING btree ("delivery_status","next_attempt_at");--> statement-breakpoint
ALTER TABLE "approval_callbacks" ADD CONSTRAINT "approval_callbacks_attempts_check" CHECK ("approval_callbacks"."attempts" BETWEEN 0 AND 10);--> statement-breakpoint
ALTER TABLE "approval_callbacks" ADD CONSTRAINT "approval_callbacks_last_error_length_check" CHECK ("approval_callbacks"."last_error" IS NULL OR char_length("approval_callbacks"."last_error") <= 200);--> statement-breakpoint
ALTER TABLE "approval_callbacks" ADD CONSTRAINT "approval_callbacks_occurred_check" CHECK (("approval_callbacks"."delivery_status" = 'WAITING') = ("approval_callbacks"."occurred_at" IS NULL));--> statement-breakpoint
ALTER TABLE "approval_callbacks" ADD CONSTRAINT "approval_callbacks_running_lease_check" CHECK ("approval_callbacks"."delivery_status" <> 'RUNNING' OR "approval_callbacks"."lease_expires_at" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "approval_callbacks" ADD CONSTRAINT "approval_callbacks_completed_check" CHECK (("approval_callbacks"."delivery_status" = 'DELIVERED') = ("approval_callbacks"."completed_at" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "approval_callbacks" ADD CONSTRAINT "approval_callbacks_dead_lettered_check" CHECK (("approval_callbacks"."delivery_status" = 'DEAD_LETTER') = ("approval_callbacks"."dead_lettered_at" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_attempts_check" CHECK ("jobs"."attempts" >= 0);--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_last_error_length_check" CHECK ("jobs"."last_error" IS NULL OR char_length("jobs"."last_error") <= 500);