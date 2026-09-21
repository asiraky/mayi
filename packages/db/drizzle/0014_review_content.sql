ALTER TABLE "approvals" ADD COLUMN "decision_outcome" text;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "title" text;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "review_markdown" text;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "review_digest" text;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "supersedes_approval_id" "mayi_id";--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_supersedes_approval_id_approvals_id_fk" FOREIGN KEY ("supersedes_approval_id") REFERENCES "public"."approvals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "approvals_supersedes_uidx" ON "approvals" USING btree ("supersedes_approval_id") WHERE "approvals"."supersedes_approval_id" IS NOT NULL;--> statement-breakpoint
-- Every decided approval predates request-changes, so its outcome is its state.
UPDATE "approvals" SET "decision_outcome" = "state"::text WHERE "state" IN ('APPROVED', 'DENIED');--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_title_check" CHECK ("approvals"."title" IS NULL OR (char_length("approvals"."title") BETWEEN 1 AND 200 AND "approvals"."title" ~ '\S' AND strpos("approvals"."title", chr(10)) = 0 AND strpos("approvals"."title", chr(13)) = 0));--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_review_markdown_check" CHECK ("approvals"."review_markdown" IS NULL OR (char_length("approvals"."review_markdown") BETWEEN 1 AND 100000 AND "approvals"."review_markdown" ~ '\S'));--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_review_digest_check" CHECK ("approvals"."review_digest" IS NULL OR "approvals"."review_digest" ~ '^[a-f0-9]{64}$');--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_supersedes_self_check" CHECK ("approvals"."supersedes_approval_id" IS NULL OR "approvals"."supersedes_approval_id" <> "approvals"."id");--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_decision_outcome_check" CHECK ("approvals"."decision_outcome" IS NULL OR "approvals"."decision_outcome" IN ('APPROVED', 'DENIED', 'CHANGES_REQUESTED'));--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_decision_outcome_state_check" CHECK (("approvals"."state" IN ('APPROVED', 'DENIED')) = ("approvals"."decision_outcome" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_decision_outcome_approved_check" CHECK (("approvals"."decision_outcome" = 'APPROVED') = ("approvals"."state" = 'APPROVED'));--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_changes_requested_check" CHECK ("approvals"."decision_outcome" IS DISTINCT FROM 'CHANGES_REQUESTED' OR ("approvals"."state" = 'DENIED' AND "approvals"."decision_comment" IS NOT NULL AND "approvals"."decision_comment" ~ '\S'));--> statement-breakpoint
-- What the reviewer read and the action they authorize are frozen once the row exists.
-- Application code never rewrites them; this makes that a database guarantee.
CREATE FUNCTION "approvals_freeze_review_content"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'approval % review content is immutable', OLD."id" USING ERRCODE = 'integrity_constraint_violation';
END
$$;--> statement-breakpoint
CREATE TRIGGER "approvals_freeze_review_content" BEFORE UPDATE ON "approvals" FOR EACH ROW
  WHEN (
    OLD."action" IS DISTINCT FROM NEW."action"
    OR OLD."explanation" IS DISTINCT FROM NEW."explanation"
    OR OLD."title" IS DISTINCT FROM NEW."title"
    OR OLD."review_markdown" IS DISTINCT FROM NEW."review_markdown"
    OR OLD."review_digest" IS DISTINCT FROM NEW."review_digest"
    OR OLD."supersedes_approval_id" IS DISTINCT FROM NEW."supersedes_approval_id"
  )
  EXECUTE FUNCTION "approvals_freeze_review_content"();
