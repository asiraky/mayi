-- Defence-in-depth tenant role. The migration owner bypasses RLS; production
-- application connections may assume mayi_app and set app.workspace_id locally.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mayi_app') THEN
    CREATE ROLE mayi_app NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
END $$;--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO mayi_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO mayi_app;--> statement-breakpoint
REVOKE UPDATE, DELETE ON audit_events FROM mayi_app;--> statement-breakpoint

ALTER TABLE agents ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE approvals ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE artefacts ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE devices ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE eligible_approvers ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE idempotency_keys ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE receipts ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE forwarding_destinations ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE forwarding_rules ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE forwarding_deliveries ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE external_nonces ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY tenant_agents ON agents TO mayi_app USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::mayi_id) WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::mayi_id);--> statement-breakpoint
CREATE POLICY tenant_approvals ON approvals TO mayi_app USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::mayi_id) WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::mayi_id);--> statement-breakpoint
CREATE POLICY tenant_artefacts ON artefacts TO mayi_app USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::mayi_id) WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::mayi_id);--> statement-breakpoint
CREATE POLICY tenant_audit ON audit_events TO mayi_app USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::mayi_id) WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::mayi_id);--> statement-breakpoint
CREATE POLICY tenant_devices ON devices TO mayi_app USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::mayi_id) WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::mayi_id);--> statement-breakpoint
CREATE POLICY tenant_eligible ON eligible_approvers TO mayi_app USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::mayi_id) WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::mayi_id);--> statement-breakpoint
CREATE POLICY tenant_idempotency ON idempotency_keys TO mayi_app USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::mayi_id) WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::mayi_id);--> statement-breakpoint
CREATE POLICY tenant_jobs ON jobs TO mayi_app USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::mayi_id) WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::mayi_id);--> statement-breakpoint
CREATE POLICY tenant_receipts ON receipts TO mayi_app USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::mayi_id) WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::mayi_id);--> statement-breakpoint
CREATE POLICY tenant_destinations ON forwarding_destinations TO mayi_app USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::mayi_id) WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::mayi_id);--> statement-breakpoint
CREATE POLICY tenant_rules ON forwarding_rules TO mayi_app USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::mayi_id) WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::mayi_id);--> statement-breakpoint
CREATE POLICY tenant_deliveries ON forwarding_deliveries TO mayi_app USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::mayi_id) WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::mayi_id);--> statement-breakpoint
CREATE POLICY tenant_external_nonces ON external_nonces TO mayi_app USING (EXISTS (SELECT 1 FROM forwarding_destinations d WHERE d.id = destination_id AND d.workspace_id = nullif(current_setting('app.workspace_id', true), '')::mayi_id)) WITH CHECK (EXISTS (SELECT 1 FROM forwarding_destinations d WHERE d.id = destination_id AND d.workspace_id = nullif(current_setting('app.workspace_id', true), '')::mayi_id));
