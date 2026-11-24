CREATE TABLE "paper_ratings" (
	"paper_id" uuid PRIMARY KEY NOT NULL,
	"venue_id" text NOT NULL,
	"field" text NOT NULL,
	"mean" double precision NOT NULL,
	"reviews" integer NOT NULL,
	"min" double precision,
	"max" double precision
);
--> statement-breakpoint
ALTER TABLE "paper_ratings" ADD CONSTRAINT "paper_ratings_paper_id_papers_id_fk" FOREIGN KEY ("paper_id") REFERENCES "public"."papers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "paper_ratings_venue_idx" ON "paper_ratings" USING btree ("venue_id");