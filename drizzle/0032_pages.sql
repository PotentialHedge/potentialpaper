-- Pages of every kind (handoffs/pages.md, Phase 1). A paper's page id is its paper id, so the page store's
-- tables are renamed in place, paper_id to page_id, and each paper gets its pages row.
CREATE TABLE "pages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "pages_kind_check" CHECK (kind in ('paper', 'venue', 'topic', 'org', 'user'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "pages_kind_key" ON "pages" USING btree ("kind","key");--> statement-breakpoint
INSERT INTO "pages" ("id", "kind", "key", "created_at") SELECT "id", 'paper', "id"::text, "created_at" FROM "papers";--> statement-breakpoint
-- A paper's page is made and deleted with it, whoever writes the paper (imports, merges, on-demand creation).
CREATE FUNCTION papers_page_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	INSERT INTO pages (id, kind, key) VALUES (NEW.id, 'paper', NEW.id::text) ON CONFLICT DO NOTHING;
	RETURN NEW;
END $$;--> statement-breakpoint
CREATE FUNCTION papers_page_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	DELETE FROM pages WHERE id = OLD.id AND kind = 'paper';
	RETURN OLD;
END $$;--> statement-breakpoint
CREATE TRIGGER papers_page_insert AFTER INSERT ON papers FOR EACH ROW EXECUTE FUNCTION papers_page_insert();--> statement-breakpoint
CREATE TRIGGER papers_page_delete AFTER DELETE ON papers FOR EACH ROW EXECUTE FUNCTION papers_page_delete();--> statement-breakpoint
ALTER TABLE "demo_pins" DROP CONSTRAINT "demo_pins_paper_id_papers_id_fk";--> statement-breakpoint
ALTER TABLE "page_current" DROP CONSTRAINT "page_current_paper_id_papers_id_fk";--> statement-breakpoint
ALTER TABLE "page_events" DROP CONSTRAINT "page_events_paper_id_papers_id_fk";--> statement-breakpoint
ALTER TABLE "page_objects" DROP CONSTRAINT "page_objects_paper_id_papers_id_fk";--> statement-breakpoint
ALTER TABLE "page_refs" DROP CONSTRAINT "page_refs_paper_id_papers_id_fk";--> statement-breakpoint
ALTER TABLE "page_revisions" DROP CONSTRAINT "page_revisions_paper_id_papers_id_fk";--> statement-breakpoint
ALTER TABLE "search_docs" DROP CONSTRAINT "search_docs_paper_id_papers_id_fk";--> statement-breakpoint
ALTER TABLE "demo_pins" RENAME COLUMN "paper_id" TO "page_id";--> statement-breakpoint
ALTER TABLE "page_current" RENAME COLUMN "paper_id" TO "page_id";--> statement-breakpoint
ALTER TABLE "page_events" RENAME COLUMN "paper_id" TO "page_id";--> statement-breakpoint
ALTER TABLE "page_objects" RENAME COLUMN "paper_id" TO "page_id";--> statement-breakpoint
ALTER TABLE "page_refs" RENAME COLUMN "paper_id" TO "page_id";--> statement-breakpoint
ALTER TABLE "page_revisions" RENAME COLUMN "paper_id" TO "page_id";--> statement-breakpoint
ALTER TABLE "search_docs" RENAME COLUMN "paper_id" TO "page_id";--> statement-breakpoint
ALTER TABLE "demo_pins" RENAME CONSTRAINT "demo_pins_paper_id_url_pk" TO "demo_pins_page_id_url_pk";--> statement-breakpoint
ALTER TABLE "page_objects" RENAME CONSTRAINT "page_objects_paper_id_oid_pk" TO "page_objects_page_id_oid_pk";--> statement-breakpoint
ALTER TABLE "page_revisions" RENAME CONSTRAINT "page_revisions_paper_id_seq_pk" TO "page_revisions_page_id_seq_pk";--> statement-breakpoint
ALTER TABLE "search_docs" RENAME CONSTRAINT "search_docs_paper_id_path_n_pk" TO "search_docs_page_id_path_n_pk";--> statement-breakpoint
ALTER INDEX "page_events_paper_seq_key" RENAME TO "page_events_page_seq_key";--> statement-breakpoint
ALTER TABLE "demo_pins" ADD CONSTRAINT "demo_pins_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_current" ADD CONSTRAINT "page_current_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_events" ADD CONSTRAINT "page_events_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_objects" ADD CONSTRAINT "page_objects_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_refs" ADD CONSTRAINT "page_refs_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_revisions" ADD CONSTRAINT "page_revisions_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_docs" ADD CONSTRAINT "search_docs_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_grants" ADD COLUMN "kind" text DEFAULT 'paper' NOT NULL;--> statement-breakpoint
ALTER TABLE "bot_grants" DROP CONSTRAINT "bot_grants_account_id_pattern_pk";--> statement-breakpoint
ALTER TABLE "bot_grants" ADD CONSTRAINT "bot_grants_account_id_kind_pattern_pk" PRIMARY KEY("account_id","kind","pattern");
