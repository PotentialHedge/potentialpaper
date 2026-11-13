CREATE TABLE "evidence_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid,
	"sha256" text NOT NULL,
	"type" text NOT NULL,
	"name" text NOT NULL,
	"bytes" integer NOT NULL,
	"url" text NOT NULL,
	"source" text,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "page_current" ADD COLUMN "versions" jsonb;--> statement-breakpoint
ALTER TABLE "page_revisions" ADD COLUMN "evidence" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "pdf_documents" ADD COLUMN "full_text" text;--> statement-breakpoint
ALTER TABLE "evidence_files" ADD CONSTRAINT "evidence_files_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "evidence_files_account_idx" ON "evidence_files" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE INDEX "evidence_files_url_idx" ON "evidence_files" USING btree ("url");