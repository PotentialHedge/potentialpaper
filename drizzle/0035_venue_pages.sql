CREATE TABLE "page_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"page_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"evidence" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "page_claims_status_check" CHECK (status in ('pending', 'confirmed', 'rejected'))
);
--> statement-breakpoint
ALTER TABLE "page_claims" ADD CONSTRAINT "page_claims_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_claims" ADD CONSTRAINT "page_claims_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_claims" ADD CONSTRAINT "page_claims_decided_by_accounts_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "page_claims_account_key" ON "page_claims" USING btree ("page_id","account_id");--> statement-breakpoint
CREATE INDEX "page_claims_status_idx" ON "page_claims" USING btree ("status");--> statement-breakpoint
-- The `venues` bot (handoffs/pages.md Phase 2) makes venue pages from the venues the OpenReview import knows, and writes their venue.json.
INSERT INTO "accounts" ("handle", "is_bot", "verified_at", "profile_completed_at") VALUES ('venues', true, now(), now()) ON CONFLICT ("handle") DO NOTHING;--> statement-breakpoint
INSERT INTO "bot_grants" ("account_id", "kind", "pattern", "shown", "granted_by") SELECT "id", 'venue', 'venue.json', true, 'system' FROM "accounts" WHERE "handle" = 'venues' AND "is_bot" ON CONFLICT DO NOTHING;
