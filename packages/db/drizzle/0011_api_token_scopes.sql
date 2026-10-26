ALTER TABLE "api_tokens" ADD COLUMN "workspace_id" uuid;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD COLUMN "scopes" jsonb;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;