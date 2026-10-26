ALTER TABLE "cost_ledger" ALTER COLUMN "units" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "cost_ledger" ALTER COLUMN "units" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "ai_summary" text;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "ai_summary_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "ai_intent" varchar(40);--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "ai_intent_score" integer;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "ai_paused_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "cost_ledger" ADD COLUMN "model" varchar(120);--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "author_kind" varchar(20) DEFAULT 'human' NOT NULL;