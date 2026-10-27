CREATE TABLE "webhook_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"channel" varchar(40) NOT NULL,
	"event_type" varchar(80),
	"outcome" varchar(20) NOT NULL,
	"http_status" integer NOT NULL,
	"workspace_id" uuid,
	"channel_account_id" uuid,
	"payload_summary" text,
	"error" text
);
--> statement-breakpoint
ALTER TABLE "webhook_receipts" ADD CONSTRAINT "webhook_receipts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_receipts" ADD CONSTRAINT "webhook_receipts_channel_account_id_channel_accounts_id_fk" FOREIGN KEY ("channel_account_id") REFERENCES "public"."channel_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "webhook_receipts_created_idx" ON "webhook_receipts" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "webhook_receipts_channel_created_idx" ON "webhook_receipts" USING btree ("channel","created_at");--> statement-breakpoint
CREATE INDEX "webhook_receipts_outcome_created_idx" ON "webhook_receipts" USING btree ("outcome","created_at");