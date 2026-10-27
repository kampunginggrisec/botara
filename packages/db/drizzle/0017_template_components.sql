ALTER TABLE "templates" ADD COLUMN "components" jsonb;--> statement-breakpoint
ALTER TABLE "templates" ADD COLUMN "rejected_reason" varchar(200);