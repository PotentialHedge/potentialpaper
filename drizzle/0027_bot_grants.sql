CREATE TABLE "bot_grants" (
	"account_id" uuid NOT NULL,
	"pattern" text NOT NULL,
	"shown" boolean DEFAULT true NOT NULL,
	"granted_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "bot_grants_account_id_pattern_pk" PRIMARY KEY("account_id","pattern")
);
--> statement-breakpoint
ALTER TABLE "bot_grants" ADD CONSTRAINT "bot_grants_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- The site's own OpenReview importer is the first bot (DESIGN.md §10): an account like any bot's, granted its source's folder.
INSERT INTO "accounts" ("handle", "is_bot", "verified_at", "profile_completed_at") VALUES ('openreview', true, now(), now()) ON CONFLICT ("handle") DO NOTHING;--> statement-breakpoint
INSERT INTO "bot_grants" ("account_id", "pattern", "shown", "granted_by") SELECT "id", 'reviews/openreview/**', true, 'system' FROM "accounts" WHERE "handle" = 'openreview' AND "is_bot" ON CONFLICT DO NOTHING;
