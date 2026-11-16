CREATE TABLE "search_docs" (
	"paper_id" uuid NOT NULL,
	"path" text NOT NULL,
	"n" integer DEFAULT 0 NOT NULL,
	"blob_oid" "bytea" NOT NULL,
	"kind" text NOT NULL,
	"scope" text NOT NULL,
	"text" text NOT NULL,
	"fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"tsv" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', text)) STORED NOT NULL,
	CONSTRAINT "search_docs_paper_id_path_n_pk" PRIMARY KEY("paper_id","path","n"),
	CONSTRAINT "search_docs_scope_check" CHECK ("search_docs"."scope" in ('page', 'reviews'))
);
--> statement-breakpoint
ALTER TABLE "search_docs" ADD CONSTRAINT "search_docs_paper_id_papers_id_fk" FOREIGN KEY ("paper_id") REFERENCES "public"."papers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "search_docs_tsv_idx" ON "search_docs" USING gin ("tsv");