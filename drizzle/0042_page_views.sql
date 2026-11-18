CREATE TABLE "page_transition_visits" (
	"day" date NOT NULL,
	"visitor" text NOT NULL,
	CONSTRAINT "page_transition_visits_day_visitor_pk" PRIMARY KEY("day","visitor")
);
--> statement-breakpoint
CREATE TABLE "page_transitions" (
	"from_page_id" uuid NOT NULL,
	"to_page_id" uuid NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "page_transitions_from_page_id_to_page_id_pk" PRIMARY KEY("from_page_id","to_page_id")
);
--> statement-breakpoint
CREATE TABLE "page_views" (
	"page_id" uuid NOT NULL,
	"day" date NOT NULL,
	"visitor" text NOT NULL,
	CONSTRAINT "page_views_page_id_day_visitor_pk" PRIMARY KEY("page_id","day","visitor")
);
--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "view_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "page_transitions_to_idx" ON "page_transitions" USING btree ("to_page_id");--> statement-breakpoint
CREATE INDEX "page_views_day_idx" ON "page_views" USING btree ("day");--> statement-breakpoint
-- A paper's page id is its paper id: its views so far carry over.
UPDATE "pages" SET "view_count" = p."view_count" FROM "papers" p WHERE p."id" = "pages"."id";--> statement-breakpoint
INSERT INTO "page_views" ("page_id", "day", "visitor") SELECT "paper_id", "day", "visitor" FROM "paper_views" ON CONFLICT DO NOTHING;
