CREATE TYPE "public"."destination_type" AS ENUM('WEBHOOK', 'EMAIL');--> statement-breakpoint
CREATE TABLE "external_nonces" (
	"destination_id" uuid NOT NULL,
	"nonce" text NOT NULL,
	"used_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "external_nonces_destination_id_nonce_pk" PRIMARY KEY("destination_id","nonce")
);
--> statement-breakpoint
CREATE TABLE "forwarding_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"approval_id" uuid NOT NULL,
	"destination_id" uuid NOT NULL,
	"origin_id" uuid NOT NULL,
	"hop_count" integer DEFAULT 1 NOT NULL,
	"state" text DEFAULT 'PENDING' NOT NULL,
	"response_code" integer,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "forwarding_destinations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"type" "destination_type" NOT NULL,
	"name" text NOT NULL,
	"endpoint" text NOT NULL,
	"mode" "destination_mode" DEFAULT 'notify_only' NOT NULL,
	"public_jwk" jsonb,
	"mapped_user_id" uuid,
	"verified_at" timestamp with time zone,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "forwarding_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"destination_id" uuid NOT NULL,
	"action_kind" text NOT NULL,
	"include_action" boolean DEFAULT false NOT NULL,
	"include_artefact_metadata" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "external_nonces" ADD CONSTRAINT "external_nonces_destination_id_forwarding_destinations_id_fk" FOREIGN KEY ("destination_id") REFERENCES "public"."forwarding_destinations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forwarding_deliveries" ADD CONSTRAINT "forwarding_deliveries_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forwarding_deliveries" ADD CONSTRAINT "forwarding_deliveries_approval_id_approvals_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."approvals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forwarding_deliveries" ADD CONSTRAINT "forwarding_deliveries_destination_id_forwarding_destinations_id_fk" FOREIGN KEY ("destination_id") REFERENCES "public"."forwarding_destinations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forwarding_destinations" ADD CONSTRAINT "forwarding_destinations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forwarding_destinations" ADD CONSTRAINT "forwarding_destinations_mapped_user_id_users_id_fk" FOREIGN KEY ("mapped_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forwarding_rules" ADD CONSTRAINT "forwarding_rules_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forwarding_rules" ADD CONSTRAINT "forwarding_rules_destination_id_forwarding_destinations_id_fk" FOREIGN KEY ("destination_id") REFERENCES "public"."forwarding_destinations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_approval_destination_uidx" ON "forwarding_deliveries" USING btree ("approval_id","destination_id");--> statement-breakpoint
CREATE INDEX "delivery_workspace_idx" ON "forwarding_deliveries" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "destinations_workspace_idx" ON "forwarding_destinations" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "forwarding_rules_match_idx" ON "forwarding_rules" USING btree ("workspace_id","action_kind");--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON forwarding_destinations, forwarding_rules, forwarding_deliveries, external_nonces TO mayi_app;--> statement-breakpoint
ALTER TABLE forwarding_destinations ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE forwarding_rules ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE forwarding_deliveries ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE external_nonces ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_destinations ON forwarding_destinations TO mayi_app USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid) WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY tenant_rules ON forwarding_rules TO mayi_app USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid) WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY tenant_deliveries ON forwarding_deliveries TO mayi_app USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid) WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY tenant_external_nonces ON external_nonces TO mayi_app USING (EXISTS (SELECT 1 FROM forwarding_destinations d WHERE d.id = destination_id AND d.workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)) WITH CHECK (EXISTS (SELECT 1 FROM forwarding_destinations d WHERE d.id = destination_id AND d.workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid));
