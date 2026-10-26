CREATE TABLE "api_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" varchar(120) NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"prefix" varchar(20) NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid,
	"user_id" uuid,
	"action" varchar(80) NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "broadcasts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"channel_account_id" uuid NOT NULL,
	"template_id" uuid,
	"name" varchar(200),
	"tag" varchar(120),
	"country" varchar(8),
	"recipient_count" integer DEFAULT 0 NOT NULL,
	"status" varchar(40) DEFAULT 'draft' NOT NULL,
	"sent_count" integer DEFAULT 0 NOT NULL,
	"failed_count" integer DEFAULT 0 NOT NULL,
	"estimated_cost_usd" numeric(14, 6),
	"rates_version" varchar(40),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "catalog_products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"channel_account_id" uuid NOT NULL,
	"catalog_id" varchar(200) NOT NULL,
	"retailer_id" varchar(200) NOT NULL,
	"name" varchar(500) NOT NULL,
	"description" text,
	"price_amount" numeric(14, 2),
	"currency" varchar(8),
	"image_url" text,
	"availability" varchar(60),
	"link" text,
	"raw" jsonb,
	"synced_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channel_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"channel" varchar(40) NOT NULL,
	"external_id" varchar(200) NOT NULL,
	"display_name" varchar(200),
	"auth_mode" varchar(60),
	"api_version" varchar(20),
	"capabilities" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_coexistence" boolean DEFAULT false NOT NULL,
	"token_vault_ref" varchar(200),
	"token_expires_at" timestamp with time zone,
	"status" varchar(40) DEFAULT 'connected' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"channel" varchar(40) NOT NULL,
	"external_id" varchar(200) NOT NULL,
	"display_name" varchar(200),
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"custom_fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"channel_account_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"status" varchar(40) DEFAULT 'open' NOT NULL,
	"assigned_user_id" uuid,
	"last_user_message_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cost_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"channel_account_id" uuid,
	"channel" varchar(40) NOT NULL,
	"category" varchar(40) NOT NULL,
	"country" varchar(8),
	"units" integer DEFAULT 1 NOT NULL,
	"amount" numeric(14, 6) DEFAULT '0' NOT NULL,
	"currency" varchar(8) DEFAULT 'USD' NOT NULL,
	"reference_id" varchar(200),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "data_deletion_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"confirmation_code" varchar(64) NOT NULL,
	"provider_user_id" varchar(200) NOT NULL,
	"status" varchar(40) DEFAULT 'received' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "flows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" varchar(200) NOT NULL,
	"trigger" jsonb DEFAULT '{"type":"manual","config":{}}'::jsonb NOT NULL,
	"graph" jsonb DEFAULT '{"startNodeId":"","nodes":[],"edges":[]}'::jsonb NOT NULL,
	"status" varchar(40) DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "growth_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"channel_account_id" uuid NOT NULL,
	"kind" varchar(40) NOT NULL,
	"slug" varchar(32) NOT NULL,
	"label" varchar(200) NOT NULL,
	"prefilled_text" text,
	"bound_flow_id" uuid,
	"target_ref" varchar(200),
	"target_url" text,
	"clicks" integer DEFAULT 0 NOT NULL,
	"conversions" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kb_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"chunk_index" integer DEFAULT 0 NOT NULL,
	"text" text NOT NULL,
	"embedding" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kb_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"title" varchar(300) NOT NULL,
	"source_text" text NOT NULL,
	"status" varchar(40) DEFAULT 'pending' NOT NULL,
	"chunk_count" integer DEFAULT 0 NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"direction" varchar(10) NOT NULL,
	"type" varchar(40) DEFAULT 'text' NOT NULL,
	"body" text,
	"payload" jsonb,
	"media_urls" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"media_keys" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"external_id" varchar(200),
	"status" varchar(40) DEFAULT 'queued' NOT NULL,
	"idempotency_key" varchar(256),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "processed_comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"channel_account_id" uuid NOT NULL,
	"comment_external_id" varchar(200) NOT NULL,
	"flow_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scheduled_posts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"text" text,
	"media_urls" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"media_keys" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"targets" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"scheduled_at" timestamp with time zone,
	"status" varchar(40) DEFAULT 'scheduled' NOT NULL,
	"results" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sequence_enrollments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"sequence_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"current_step" integer DEFAULT 0 NOT NULL,
	"status" varchar(40) DEFAULT 'active' NOT NULL,
	"next_step_at" timestamp with time zone,
	"last_step_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sequences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"channel_account_id" uuid NOT NULL,
	"name" varchar(200) NOT NULL,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" varchar(40) DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"channel_account_id" uuid NOT NULL,
	"external_id" varchar(200),
	"name" varchar(200) NOT NULL,
	"language" varchar(20) DEFAULT 'en' NOT NULL,
	"category" varchar(40),
	"latest_category" varchar(40),
	"messaging_account_id" varchar(200),
	"status" varchar(40) DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "token_vault" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"kind" varchar(60) NOT NULL,
	"label" varchar(200),
	"ciphertext" text NOT NULL,
	"iv" varchar(64) NOT NULL,
	"auth_tag" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"rotated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" varchar(320) NOT NULL,
	"name" varchar(200),
	"password_hash" varchar(300),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webchat_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"token" varchar(200) NOT NULL,
	"contact_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"visitor_name" varchar(200),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_domains" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"domain" varchar(255) NOT NULL,
	"channel_account_id" uuid,
	"resend_domain_id" varchar(200),
	"status" varchar(40) DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" varchar(40) DEFAULT 'member' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(200) NOT NULL,
	"slug" varchar(120) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broadcasts" ADD CONSTRAINT "broadcasts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broadcasts" ADD CONSTRAINT "broadcasts_channel_account_id_channel_accounts_id_fk" FOREIGN KEY ("channel_account_id") REFERENCES "public"."channel_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broadcasts" ADD CONSTRAINT "broadcasts_template_id_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."templates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_products" ADD CONSTRAINT "catalog_products_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_products" ADD CONSTRAINT "catalog_products_channel_account_id_channel_accounts_id_fk" FOREIGN KEY ("channel_account_id") REFERENCES "public"."channel_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_accounts" ADD CONSTRAINT "channel_accounts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_channel_account_id_channel_accounts_id_fk" FOREIGN KEY ("channel_account_id") REFERENCES "public"."channel_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_assigned_user_id_users_id_fk" FOREIGN KEY ("assigned_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_ledger" ADD CONSTRAINT "cost_ledger_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_ledger" ADD CONSTRAINT "cost_ledger_channel_account_id_channel_accounts_id_fk" FOREIGN KEY ("channel_account_id") REFERENCES "public"."channel_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flows" ADD CONSTRAINT "flows_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "growth_links" ADD CONSTRAINT "growth_links_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "growth_links" ADD CONSTRAINT "growth_links_channel_account_id_channel_accounts_id_fk" FOREIGN KEY ("channel_account_id") REFERENCES "public"."channel_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "growth_links" ADD CONSTRAINT "growth_links_bound_flow_id_flows_id_fk" FOREIGN KEY ("bound_flow_id") REFERENCES "public"."flows"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_chunks" ADD CONSTRAINT "kb_chunks_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_chunks" ADD CONSTRAINT "kb_chunks_document_id_kb_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."kb_documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_documents" ADD CONSTRAINT "kb_documents_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processed_comments" ADD CONSTRAINT "processed_comments_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processed_comments" ADD CONSTRAINT "processed_comments_channel_account_id_channel_accounts_id_fk" FOREIGN KEY ("channel_account_id") REFERENCES "public"."channel_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processed_comments" ADD CONSTRAINT "processed_comments_flow_id_flows_id_fk" FOREIGN KEY ("flow_id") REFERENCES "public"."flows"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_posts" ADD CONSTRAINT "scheduled_posts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sequence_enrollments" ADD CONSTRAINT "sequence_enrollments_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sequence_enrollments" ADD CONSTRAINT "sequence_enrollments_sequence_id_sequences_id_fk" FOREIGN KEY ("sequence_id") REFERENCES "public"."sequences"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sequence_enrollments" ADD CONSTRAINT "sequence_enrollments_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sequences" ADD CONSTRAINT "sequences_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sequences" ADD CONSTRAINT "sequences_channel_account_id_channel_accounts_id_fk" FOREIGN KEY ("channel_account_id") REFERENCES "public"."channel_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "templates" ADD CONSTRAINT "templates_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "templates" ADD CONSTRAINT "templates_channel_account_id_channel_accounts_id_fk" FOREIGN KEY ("channel_account_id") REFERENCES "public"."channel_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "token_vault" ADD CONSTRAINT "token_vault_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webchat_sessions" ADD CONSTRAINT "webchat_sessions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webchat_sessions" ADD CONSTRAINT "webchat_sessions_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webchat_sessions" ADD CONSTRAINT "webchat_sessions_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_domains" ADD CONSTRAINT "workspace_domains_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_domains" ADD CONSTRAINT "workspace_domains_channel_account_id_channel_accounts_id_fk" FOREIGN KEY ("channel_account_id") REFERENCES "public"."channel_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "api_tokens_hash_idx" ON "api_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "api_tokens_user_idx" ON "api_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "audit_log_ws_created_idx" ON "audit_log" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "broadcasts_ws_idx" ON "broadcasts" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_products_account_catalog_retailer_idx" ON "catalog_products" USING btree ("channel_account_id","catalog_id","retailer_id");--> statement-breakpoint
CREATE INDEX "catalog_products_ws_idx" ON "catalog_products" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "channel_accounts_ws_idx" ON "channel_accounts" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "contacts_ws_channel_ext_idx" ON "contacts" USING btree ("workspace_id","channel","external_id");--> statement-breakpoint
CREATE INDEX "conversations_ws_idx" ON "conversations" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "cost_ledger_ws_created_idx" ON "cost_ledger" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "data_deletion_requests_code_idx" ON "data_deletion_requests" USING btree ("confirmation_code");--> statement-breakpoint
CREATE INDEX "flows_ws_status_idx" ON "flows" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "growth_links_slug_idx" ON "growth_links" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "growth_links_ws_idx" ON "growth_links" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "kb_chunks_ws_idx" ON "kb_chunks" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "kb_chunks_document_idx" ON "kb_chunks" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "kb_documents_ws_idx" ON "kb_documents" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "messages_conversation_idx" ON "messages" USING btree ("conversation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "processed_comments_account_comment_flow_idx" ON "processed_comments" USING btree ("channel_account_id","comment_external_id","flow_id");--> statement-breakpoint
CREATE INDEX "scheduled_posts_ws_status_idx" ON "scheduled_posts" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "sequence_enrollments_seq_contact_idx" ON "sequence_enrollments" USING btree ("sequence_id","contact_id");--> statement-breakpoint
CREATE INDEX "sequence_enrollments_due_idx" ON "sequence_enrollments" USING btree ("status","next_step_at");--> statement-breakpoint
CREATE INDEX "sequences_ws_idx" ON "sequences" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "token_vault_ws_idx" ON "token_vault" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_idx" ON "users" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "webchat_sessions_token_idx" ON "webchat_sessions" USING btree ("token");--> statement-breakpoint
CREATE INDEX "webchat_sessions_ws_idx" ON "webchat_sessions" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_domains_domain_idx" ON "workspace_domains" USING btree ("domain");--> statement-breakpoint
CREATE INDEX "workspace_domains_ws_idx" ON "workspace_domains" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_members_ws_user_idx" ON "workspace_members" USING btree ("workspace_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workspaces_slug_idx" ON "workspaces" USING btree ("slug");