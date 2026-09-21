ALTER TABLE "agents" ADD COLUMN "revoked_by" "mayi_id";--> statement-breakpoint
ALTER TABLE "oauth_codes" ADD COLUMN "agent_id" "mayi_id";--> statement-breakpoint
ALTER TABLE "oauth_codes" ADD COLUMN "label" text;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_revoked_by_users_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_codes" ADD CONSTRAINT "oauth_codes_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_revoked_by_check" CHECK ("agents"."revoked_by" IS NULL OR "agents"."revoked_at" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "oauth_codes" ADD CONSTRAINT "oauth_codes_label_length_check" CHECK ("oauth_codes"."label" IS NULL OR char_length("oauth_codes"."label") BETWEEN 1 AND 100);--> statement-breakpoint
-- Revokes recorded before this column existed cannot be told apart reliably, so every
-- already-revoked agent is treated as owner-revoked (final). The audit trail names the
-- owner where it still exists; otherwise the connection's creator stands in.
UPDATE "agents" a SET "revoked_by" = coalesce(
  (SELECT e."actor_id" FROM "audit_events" e
    JOIN "users" u ON u."id" = e."actor_id"
    WHERE e."event_type" = 'agent.revoked' AND e."subject_id" = a."id"
    ORDER BY e."created_at" DESC LIMIT 1),
  a."created_by"
) WHERE a."revoked_at" IS NOT NULL;
