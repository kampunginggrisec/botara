CREATE TABLE "saved_replies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"title" varchar(200) NOT NULL,
	"body" text NOT NULL,
	"shortcut" varchar(60),
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "kind" varchar(20) DEFAULT 'message' NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "author_user_id" uuid;--> statement-breakpoint
ALTER TABLE "saved_replies" ADD CONSTRAINT "saved_replies_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_replies" ADD CONSTRAINT "saved_replies_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "saved_replies_ws_idx" ON "saved_replies" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "saved_replies_ws_shortcut_idx" ON "saved_replies" USING btree ("workspace_id","shortcut") WHERE "saved_replies"."shortcut" is not null;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;