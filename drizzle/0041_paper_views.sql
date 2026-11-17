CREATE TABLE "paper_views" (
	"paper_id" uuid NOT NULL,
	"day" date NOT NULL,
	"visitor" text NOT NULL,
	CONSTRAINT "paper_views_paper_id_day_visitor_pk" PRIMARY KEY("paper_id","day","visitor")
);
--> statement-breakpoint
ALTER TABLE "papers" ADD COLUMN "view_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "paper_views_day_idx" ON "paper_views" USING btree ("day");