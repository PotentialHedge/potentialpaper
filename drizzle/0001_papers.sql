CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE TABLE "paper_identifiers" (
	"scheme" text NOT NULL,
	"value" text NOT NULL,
	"paper_id" uuid NOT NULL,
	CONSTRAINT "paper_identifiers_scheme_value_pk" PRIMARY KEY("scheme","value"),
	CONSTRAINT "paper_identifiers_scheme_check" CHECK ("paper_identifiers"."scheme" in ('arxiv', 'doi', 'openreview'))
);
--> statement-breakpoint
CREATE TABLE "paper_lookup_misses" (
	"scheme" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "paper_lookup_misses_scheme_value_pk" PRIMARY KEY("scheme","value")
);
--> statement-breakpoint
CREATE TABLE "papers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"authors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"abstract" text,
	"year" integer,
	"venue" text,
	"merged_into" uuid,
	"search" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('english', title), 'A') || setweight(to_tsvector('english', coalesce(abstract, '')), 'B')) STORED NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "paper_identifiers" ADD CONSTRAINT "paper_identifiers_paper_id_papers_id_fk" FOREIGN KEY ("paper_id") REFERENCES "public"."papers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "papers" ADD CONSTRAINT "papers_merged_into_papers_id_fk" FOREIGN KEY ("merged_into") REFERENCES "public"."papers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "paper_identifiers_paper_id_idx" ON "paper_identifiers" USING btree ("paper_id");--> statement-breakpoint
CREATE INDEX "papers_search_idx" ON "papers" USING gin ("search");--> statement-breakpoint
CREATE INDEX "papers_title_trgm_idx" ON "papers" USING gin ("title" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "papers_merged_into_idx" ON "papers" USING btree ("merged_into");