ALTER TABLE "agents" ALTER COLUMN "client_id" SET DATA TYPE "public"."mayi_id" USING "client_id"::"public"."mayi_id";--> statement-breakpoint
ALTER TABLE "oauth_clients" ADD COLUMN "approval_callback_uris" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "oauth_clients" ALTER COLUMN "approval_callback_uris" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "oauth_clients" ADD COLUMN "registration_ip_hash" text DEFAULT repeat('0', 64) NOT NULL;--> statement-breakpoint
ALTER TABLE "oauth_clients" ALTER COLUMN "registration_ip_hash" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_client_id_oauth_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agents_client_idx" ON "agents" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "oauth_clients_registration_ip_created_idx" ON "oauth_clients" USING btree ("registration_ip_hash","created_at");--> statement-breakpoint
ALTER TABLE "oauth_clients" ADD CONSTRAINT "oauth_clients_redirect_uri_count_check" CHECK (cardinality("oauth_clients"."redirect_uris") BETWEEN 1 AND 5);--> statement-breakpoint
ALTER TABLE "oauth_clients" ADD CONSTRAINT "oauth_clients_approval_callback_uri_count_check" CHECK (cardinality("oauth_clients"."approval_callback_uris") <= 10);
