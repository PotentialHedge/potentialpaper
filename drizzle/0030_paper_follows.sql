CREATE TABLE "paper_follows" (
	"account_id" uuid NOT NULL,
	"paper_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "paper_follows_account_id_paper_id_pk" PRIMARY KEY("account_id","paper_id")
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "follow_mail" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "paper_follows" ADD CONSTRAINT "paper_follows_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paper_follows" ADD CONSTRAINT "paper_follows_paper_id_papers_id_fk" FOREIGN KEY ("paper_id") REFERENCES "public"."papers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "paper_follows_paper_idx" ON "paper_follows" USING btree ("paper_id");--> statement-breakpoint
INSERT INTO "paper_follows" ("account_id", "paper_id") SELECT "account_id", "paper_id" FROM "author_claims" WHERE "status" = 'confirmed' ON CONFLICT DO NOTHING;
