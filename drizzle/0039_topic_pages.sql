CREATE TABLE "page_protection" (
	"page_id" uuid PRIMARY KEY NOT NULL,
	"level" text NOT NULL,
	"reason" text,
	"set_by" uuid,
	"set_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"expires_at" timestamp with time zone,
	CONSTRAINT "page_protection_level_check" CHECK (level in ('established', 'admins'))
);
--> statement-breakpoint
CREATE TABLE "topic_suggestions" (
	"topic_page_id" uuid NOT NULL,
	"paper_id" uuid NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"reason" text NOT NULL,
	"matched" text NOT NULL,
	"score" double precision NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "topic_suggestions_topic_page_id_paper_id_pk" PRIMARY KEY("topic_page_id","paper_id"),
	CONSTRAINT "topic_suggestions_status_check" CHECK (status in ('open', 'dismissed', 'confirmed')),
	CONSTRAINT "topic_suggestions_reason_check" CHECK (reason in ('keyword', 'title', 'abstract'))
);
--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "merged_into" uuid;--> statement-breakpoint
ALTER TABLE "submissions" ADD COLUMN "keywords" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "page_protection" ADD CONSTRAINT "page_protection_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_protection" ADD CONSTRAINT "page_protection_set_by_accounts_id_fk" FOREIGN KEY ("set_by") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topic_suggestions" ADD CONSTRAINT "topic_suggestions_topic_page_id_pages_id_fk" FOREIGN KEY ("topic_page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topic_suggestions" ADD CONSTRAINT "topic_suggestions_paper_id_pages_id_fk" FOREIGN KEY ("paper_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "topic_suggestions" ADD CONSTRAINT "topic_suggestions_decided_by_accounts_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "topic_suggestions_open_idx" ON "topic_suggestions" USING btree ("topic_page_id","status","score");--> statement-breakpoint
CREATE INDEX "topic_suggestions_paper_idx" ON "topic_suggestions" USING btree ("paper_id");--> statement-breakpoint
ALTER TABLE "pages" ADD CONSTRAINT "pages_merged_into_pages_id_fk" FOREIGN KEY ("merged_into") REFERENCES "public"."pages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pages_merged_into_idx" ON "pages" USING btree ("merged_into");--> statement-breakpoint
-- Topic pages (handoffs/pages.md, Phase 5): a renamed topic leaves its old slug in page_redirects. Whatever page takes
-- a key takes its address, whichever kind it is and whoever writes it: an old redirect from that key gives way.
CREATE FUNCTION pages_take_redirect() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	DELETE FROM page_redirects WHERE kind = NEW.kind AND key = NEW.key;
	RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER pages_take_redirect AFTER INSERT OR UPDATE OF key ON pages FOR EACH ROW EXECUTE FUNCTION pages_take_redirect();
