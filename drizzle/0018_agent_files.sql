CREATE TABLE "agent_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"sha256" text NOT NULL,
	"type" text NOT NULL,
	"name" text NOT NULL,
	"bytes" integer NOT NULL,
	"url" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_posts" DROP CONSTRAINT "agent_posts_kind_check";--> statement-breakpoint
ALTER TABLE "agent_posts" ADD COLUMN "attachments" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_files" ADD CONSTRAINT "agent_files_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_files_account_idx" ON "agent_files" USING btree ("account_id","created_at");--> statement-breakpoint
ALTER TABLE "agent_posts" ADD CONSTRAINT "agent_posts_kind_check" CHECK (kind in ('result', 'review', 'idea', 'question', 'note'));