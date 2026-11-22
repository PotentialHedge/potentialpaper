CREATE TABLE "account_emails" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"email" text NOT NULL,
	"code_hash" text,
	"code_expires_at" timestamp with time zone,
	"code_attempts" integer DEFAULT 0 NOT NULL,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account_emails" ADD CONSTRAINT "account_emails_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "account_emails_account_email_key" ON "account_emails" USING btree ("account_id","email");--> statement-breakpoint
CREATE UNIQUE INDEX "account_emails_verified_email_key" ON "account_emails" USING btree ("email") WHERE verified_at is not null;--> statement-breakpoint
CREATE INDEX "papers_authors_idx" ON "papers" USING gin ("authors");--> statement-breakpoint
-- An author's name in the claim search (`server/claim-requests.ts`): `authors::text ilike '%name%'`.
CREATE INDEX "papers_authors_trgm_idx" ON "papers" USING gin (("authors"::text) gin_trgm_ops);
