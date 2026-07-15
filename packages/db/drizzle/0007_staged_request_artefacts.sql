ALTER TABLE "artefacts" ALTER COLUMN "approval_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "artefacts" ADD COLUMN "agent_id" "mayi_id";--> statement-breakpoint
UPDATE "artefacts" AS f SET "agent_id" = a."agent_id" FROM "approvals" AS a WHERE f."approval_id" = a."id";--> statement-breakpoint
ALTER TABLE "artefacts" ADD COLUMN "request_key" text;--> statement-breakpoint
ALTER TABLE "artefacts" ADD COLUMN "upload_ordinal" integer;--> statement-breakpoint
ALTER TABLE "artefacts" ADD COLUMN "upload_payload_hash" text;--> statement-breakpoint
ALTER TABLE "artefacts" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "artefacts" ADD CONSTRAINT "artefacts_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "artefacts_staged_request_uidx" ON "artefacts" USING btree ("workspace_id","agent_id","request_key","upload_ordinal") WHERE "artefacts"."request_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "artefacts_staged_expiry_idx" ON "artefacts" USING btree ("expires_at") WHERE "artefacts"."approval_id" IS NULL AND "artefacts"."expires_at" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "artefacts" ADD CONSTRAINT "artefacts_state_check" CHECK ("artefacts"."state" IN ('UPLOADING', 'READY'));--> statement-breakpoint
ALTER TABLE "artefacts" ADD CONSTRAINT "artefacts_upload_ordinal_check" CHECK ("artefacts"."upload_ordinal" IS NULL OR "artefacts"."upload_ordinal" BETWEEN 0 AND 19);--> statement-breakpoint
ALTER TABLE "artefacts" ADD CONSTRAINT "artefacts_staging_check" CHECK (
    ("artefacts"."request_key" IS NULL AND "artefacts"."approval_id" IS NOT NULL)
    OR
    ("artefacts"."request_key" IS NOT NULL AND "artefacts"."agent_id" IS NOT NULL AND "artefacts"."upload_ordinal" IS NOT NULL AND "artefacts"."upload_payload_hash" IS NOT NULL AND "artefacts"."expires_at" IS NOT NULL)
  );
