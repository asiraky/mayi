ALTER TABLE "artefacts" DROP CONSTRAINT "artefacts_state_check";--> statement-breakpoint
ALTER TABLE "artefacts" DROP CONSTRAINT "artefacts_staging_check";--> statement-breakpoint
ALTER TABLE "artefacts" ADD CONSTRAINT "artefacts_state_check" CHECK ("artefacts"."state" IN ('UPLOADING', 'READY', 'DELETING'));--> statement-breakpoint
ALTER TABLE "artefacts" ADD CONSTRAINT "artefacts_staging_check" CHECK (
    ("artefacts"."request_key" IS NULL AND "artefacts"."approval_id" IS NOT NULL)
    OR
    ("artefacts"."request_key" IS NOT NULL AND "artefacts"."agent_id" IS NOT NULL AND "artefacts"."upload_ordinal" IS NOT NULL AND "artefacts"."upload_payload_hash" IS NOT NULL AND "artefacts"."expires_at" IS NOT NULL
      AND ("artefacts"."state" <> 'DELETING' OR "artefacts"."approval_id" IS NULL))
  );
