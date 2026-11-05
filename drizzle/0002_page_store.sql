CREATE TABLE "commit_identities" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" uuid,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "page_current" (
	"paper_id" uuid PRIMARY KEY NOT NULL,
	"head" "bytea" NOT NULL,
	"author_markdown" text,
	"community_markdown" text,
	"resources" jsonb,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "page_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "page_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"paper_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "page_objects" (
	"paper_id" uuid NOT NULL,
	"oid" "bytea" NOT NULL,
	"type" text NOT NULL,
	"body" "bytea" NOT NULL,
	CONSTRAINT "page_objects_paper_id_oid_pk" PRIMARY KEY("paper_id","oid"),
	CONSTRAINT "page_objects_type_check" CHECK ("page_objects"."type" in ('blob', 'tree', 'commit'))
);
--> statement-breakpoint
CREATE TABLE "page_refs" (
	"paper_id" uuid PRIMARY KEY NOT NULL,
	"head" "bytea" NOT NULL
);
--> statement-breakpoint
CREATE TABLE "page_revisions" (
	"paper_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"oid" "bytea" NOT NULL,
	"author_id" text NOT NULL,
	"account_id" uuid,
	"kind" text NOT NULL,
	"summary" text NOT NULL,
	"paths" text[] NOT NULL,
	"bytes_delta" integer NOT NULL,
	"at" timestamp with time zone NOT NULL,
	CONSTRAINT "page_revisions_paper_id_seq_pk" PRIMARY KEY("paper_id","seq"),
	CONSTRAINT "page_revisions_kind_check" CHECK ("page_revisions"."kind" in ('edit', 'revert'))
);
--> statement-breakpoint
ALTER TABLE "commit_identities" ADD CONSTRAINT "commit_identities_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_current" ADD CONSTRAINT "page_current_paper_id_papers_id_fk" FOREIGN KEY ("paper_id") REFERENCES "public"."papers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_events" ADD CONSTRAINT "page_events_paper_id_papers_id_fk" FOREIGN KEY ("paper_id") REFERENCES "public"."papers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_objects" ADD CONSTRAINT "page_objects_paper_id_papers_id_fk" FOREIGN KEY ("paper_id") REFERENCES "public"."papers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_refs" ADD CONSTRAINT "page_refs_paper_id_papers_id_fk" FOREIGN KEY ("paper_id") REFERENCES "public"."papers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_revisions" ADD CONSTRAINT "page_revisions_paper_id_papers_id_fk" FOREIGN KEY ("paper_id") REFERENCES "public"."papers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_revisions" ADD CONSTRAINT "page_revisions_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "commit_identities_account_key" ON "commit_identities" USING btree ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "page_events_paper_seq_key" ON "page_events" USING btree ("paper_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "page_revisions_oid_key" ON "page_revisions" USING btree ("paper_id","oid");--> statement-breakpoint
CREATE INDEX "page_revisions_account_idx" ON "page_revisions" USING btree ("account_id");