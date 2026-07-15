CREATE TABLE "oauth_registration_attempts" (
	"identity_hash" text PRIMARY KEY NOT NULL,
	"window_started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 1 NOT NULL,
	"last_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oauth_registration_attempts_count_check" CHECK ("oauth_registration_attempts"."attempts" BETWEEN 1 AND 31)
);
--> statement-breakpoint
CREATE INDEX "oauth_registration_attempts_last_attempt_idx" ON "oauth_registration_attempts" USING btree ("last_attempt_at");--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "oauth_registration_attempts" TO mayi_app;
