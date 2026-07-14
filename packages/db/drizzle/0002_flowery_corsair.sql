ALTER TABLE "forwarding_destinations" ADD COLUMN "verification_hash" text;--> statement-breakpoint
ALTER TABLE "forwarding_destinations" ADD COLUMN "verification_expires_at" timestamp with time zone;