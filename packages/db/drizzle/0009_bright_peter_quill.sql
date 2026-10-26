CREATE TABLE "flow_waits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"channel_account_id" uuid NOT NULL,
	"flow_id" uuid NOT NULL,
	"node_id" varchar(200) NOT NULL,
	"variable" varchar(120) NOT NULL,
	"save_to_contact_field" varchar(200),
	"resume_state" jsonb NOT NULL,
	"deadline_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "flow_waits" ADD CONSTRAINT "flow_waits_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flow_waits" ADD CONSTRAINT "flow_waits_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flow_waits" ADD CONSTRAINT "flow_waits_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flow_waits" ADD CONSTRAINT "flow_waits_channel_account_id_channel_accounts_id_fk" FOREIGN KEY ("channel_account_id") REFERENCES "public"."channel_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flow_waits" ADD CONSTRAINT "flow_waits_flow_id_flows_id_fk" FOREIGN KEY ("flow_id") REFERENCES "public"."flows"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "flow_waits_conversation_idx" ON "flow_waits" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "flow_waits_deadline_idx" ON "flow_waits" USING btree ("deadline_at");