CREATE TYPE "public"."input_state" AS ENUM('PENDING', 'ANSWERED', 'EXPIRED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."input_type" AS ENUM('text', 'select', 'confirmation');--> statement-breakpoint
CREATE TABLE "input_callbacks" (
	"id" "mayi_id" PRIMARY KEY NOT NULL,
	"input_id" "mayi_id" NOT NULL,
	"workspace_id" "mayi_id" NOT NULL,
	"url" text NOT NULL,
	"state" text NOT NULL,
	"delivery_status" "callback_delivery_status" DEFAULT 'WAITING' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"lease_expires_at" timestamp with time zone,
	"last_error" text,
	"occurred_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"dead_lettered_at" timestamp with time zone,
	CONSTRAINT "input_callbacks_url_length_check" CHECK (char_length("input_callbacks"."url") BETWEEN 1 AND 2048),
	CONSTRAINT "input_callbacks_state_length_check" CHECK (char_length("input_callbacks"."state") BETWEEN 1 AND 32768),
	CONSTRAINT "input_callbacks_attempts_check" CHECK ("input_callbacks"."attempts" BETWEEN 0 AND 10),
	CONSTRAINT "input_callbacks_last_error_length_check" CHECK ("input_callbacks"."last_error" IS NULL OR char_length("input_callbacks"."last_error") <= 200),
	CONSTRAINT "input_callbacks_occurred_check" CHECK (("input_callbacks"."delivery_status" = 'WAITING') = ("input_callbacks"."occurred_at" IS NULL)),
	CONSTRAINT "input_callbacks_running_lease_check" CHECK ("input_callbacks"."delivery_status" <> 'RUNNING' OR "input_callbacks"."lease_expires_at" IS NOT NULL),
	CONSTRAINT "input_callbacks_completed_check" CHECK (("input_callbacks"."delivery_status" = 'DELIVERED') = ("input_callbacks"."completed_at" IS NOT NULL)),
	CONSTRAINT "input_callbacks_dead_lettered_check" CHECK (("input_callbacks"."delivery_status" = 'DEAD_LETTER') = ("input_callbacks"."dead_lettered_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "input_eligible_respondents" (
	"input_id" "mayi_id" NOT NULL,
	"workspace_id" "mayi_id" NOT NULL,
	"user_id" "mayi_id" NOT NULL,
	CONSTRAINT "input_eligible_respondents_input_id_user_id_pk" PRIMARY KEY("input_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "inputs" (
	"id" "mayi_id" PRIMARY KEY NOT NULL,
	"workspace_id" "mayi_id" NOT NULL,
	"agent_id" "mayi_id" NOT NULL,
	"type" "input_type" NOT NULL,
	"prompt" text NOT NULL,
	"options" jsonb,
	"allow_freeform" boolean DEFAULT false NOT NULL,
	"state" "input_state" DEFAULT 'PENDING' NOT NULL,
	"answer" jsonb,
	"attestation" text,
	"respondent_id" "mayi_id",
	"suggested_approver_id" "mayi_id",
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"answered_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	CONSTRAINT "inputs_answered_check" CHECK (("inputs"."state" = 'ANSWERED') = ("inputs"."answer" IS NOT NULL AND "inputs"."attestation" IS NOT NULL AND "inputs"."respondent_id" IS NOT NULL AND "inputs"."answered_at" IS NOT NULL)),
	CONSTRAINT "inputs_cancelled_check" CHECK (("inputs"."state" = 'CANCELLED') = ("inputs"."cancelled_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "input_callbacks" ADD CONSTRAINT "input_callbacks_input_id_inputs_id_fk" FOREIGN KEY ("input_id") REFERENCES "public"."inputs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "input_callbacks" ADD CONSTRAINT "input_callbacks_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "input_eligible_respondents" ADD CONSTRAINT "input_eligible_respondents_input_id_inputs_id_fk" FOREIGN KEY ("input_id") REFERENCES "public"."inputs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "input_eligible_respondents" ADD CONSTRAINT "input_eligible_respondents_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "input_eligible_respondents" ADD CONSTRAINT "input_eligible_respondents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inputs" ADD CONSTRAINT "inputs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inputs" ADD CONSTRAINT "inputs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inputs" ADD CONSTRAINT "inputs_respondent_id_users_id_fk" FOREIGN KEY ("respondent_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inputs" ADD CONSTRAINT "inputs_suggested_approver_id_users_id_fk" FOREIGN KEY ("suggested_approver_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "input_callbacks_input_uidx" ON "input_callbacks" USING btree ("input_id");--> statement-breakpoint
CREATE INDEX "input_callbacks_workspace_idx" ON "input_callbacks" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "input_callbacks_delivery_idx" ON "input_callbacks" USING btree ("delivery_status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "input_eligible_user_idx" ON "input_eligible_respondents" USING btree ("workspace_id","user_id");--> statement-breakpoint
CREATE INDEX "inputs_workspace_state_idx" ON "inputs" USING btree ("workspace_id","state","created_at");--> statement-breakpoint
CREATE INDEX "inputs_expiry_idx" ON "inputs" USING btree ("state","expires_at");--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "inputs" TO mayi_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "input_callbacks" TO mayi_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "input_eligible_respondents" TO mayi_app;--> statement-breakpoint
ALTER TABLE "inputs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "input_callbacks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "input_eligible_respondents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_inputs ON "inputs" TO mayi_app
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::mayi_id)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::mayi_id);--> statement-breakpoint
CREATE POLICY tenant_input_callbacks ON "input_callbacks" TO mayi_app
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::mayi_id)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::mayi_id);--> statement-breakpoint
CREATE POLICY tenant_input_eligible ON "input_eligible_respondents" TO mayi_app
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::mayi_id)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::mayi_id);
