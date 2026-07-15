CREATE TABLE "approval_callbacks" (
	"id" "mayi_id" PRIMARY KEY NOT NULL,
	"approval_id" "mayi_id" NOT NULL,
	"workspace_id" "mayi_id" NOT NULL,
	"url" text NOT NULL,
	"state" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "approval_callbacks_url_length_check" CHECK (char_length("approval_callbacks"."url") BETWEEN 1 AND 2048),
	CONSTRAINT "approval_callbacks_state_length_check" CHECK (char_length("approval_callbacks"."state") BETWEEN 1 AND 32768)
);
--> statement-breakpoint
ALTER TABLE "approval_callbacks" ADD CONSTRAINT "approval_callbacks_approval_id_approvals_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."approvals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_callbacks" ADD CONSTRAINT "approval_callbacks_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "approval_callbacks_approval_uidx" ON "approval_callbacks" USING btree ("approval_id");--> statement-breakpoint
CREATE INDEX "approval_callbacks_workspace_idx" ON "approval_callbacks" USING btree ("workspace_id","created_at");--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "approval_callbacks" TO mayi_app;--> statement-breakpoint
ALTER TABLE "approval_callbacks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_approval_callbacks ON "approval_callbacks" TO mayi_app
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::mayi_id)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::mayi_id);
