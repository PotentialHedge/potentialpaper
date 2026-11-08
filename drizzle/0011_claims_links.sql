CREATE TABLE "author_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"paper_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"author_index" integer NOT NULL,
	"author_name" text NOT NULL,
	"evidence" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"identity_id" text NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "author_claims_status_check" CHECK (status in ('pending', 'confirmed', 'rejected'))
);
--> statement-breakpoint
ALTER TABLE "page_current" ADD COLUMN "links" jsonb;--> statement-breakpoint
ALTER TABLE "author_claims" ADD CONSTRAINT "author_claims_paper_id_papers_id_fk" FOREIGN KEY ("paper_id") REFERENCES "public"."papers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "author_claims" ADD CONSTRAINT "author_claims_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "author_claims" ADD CONSTRAINT "author_claims_decided_by_accounts_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "author_claims_account_key" ON "author_claims" USING btree ("paper_id","account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "author_claims_identity_key" ON "author_claims" USING btree ("identity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "author_claims_confirmed_author_key" ON "author_claims" USING btree ("paper_id","author_index") WHERE "author_claims"."status" = 'confirmed';--> statement-breakpoint
CREATE INDEX "author_claims_status_idx" ON "author_claims" USING btree ("status");