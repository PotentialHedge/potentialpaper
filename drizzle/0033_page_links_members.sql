CREATE TABLE "page_ancestors" (
	"page_id" uuid NOT NULL,
	"ancestor_id" uuid NOT NULL,
	"depth" integer NOT NULL,
	CONSTRAINT "page_ancestors_page_id_ancestor_id_pk" PRIMARY KEY("page_id","ancestor_id")
);
--> statement-breakpoint
CREATE TABLE "page_links" (
	"page_id" uuid NOT NULL,
	"path" text NOT NULL,
	"link_id" text NOT NULL,
	"line" integer NOT NULL,
	"target" text NOT NULL,
	"target_kind" text NOT NULL,
	"target_page_id" uuid,
	"label" text NOT NULL,
	"origin" text NOT NULL,
	"note" text,
	"from_anchor" text,
	"to_anchor" text,
	"evidence" text,
	CONSTRAINT "page_links_page_id_path_link_id_pk" PRIMARY KEY("page_id","path","link_id")
);
--> statement-breakpoint
CREATE TABLE "page_member_sources" (
	"paper_id" uuid NOT NULL,
	"via" text NOT NULL,
	"source" text NOT NULL,
	CONSTRAINT "page_member_sources_paper_id_via_source_pk" PRIMARY KEY("paper_id","via","source")
);
--> statement-breakpoint
CREATE TABLE "page_members" (
	"scope_page_id" uuid NOT NULL,
	"paper_id" uuid NOT NULL,
	"via" text NOT NULL,
	"weight" double precision DEFAULT 1 NOT NULL,
	CONSTRAINT "page_members_scope_page_id_paper_id_via_pk" PRIMARY KEY("scope_page_id","paper_id","via")
);
--> statement-breakpoint
CREATE TABLE "page_parents" (
	"page_id" uuid NOT NULL,
	"parent" text NOT NULL,
	CONSTRAINT "page_parents_page_id_parent_pk" PRIMARY KEY("page_id","parent")
);
--> statement-breakpoint
CREATE TABLE "page_scope_names" (
	"page_id" uuid NOT NULL,
	"name" text NOT NULL,
	CONSTRAINT "page_scope_names_page_id_name_pk" PRIMARY KEY("page_id","name")
);
--> statement-breakpoint
ALTER TABLE "page_current" ADD COLUMN "kind_file" jsonb;--> statement-breakpoint
ALTER TABLE "page_current" ADD COLUMN "name" text;--> statement-breakpoint
ALTER TABLE "page_ancestors" ADD CONSTRAINT "page_ancestors_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_ancestors" ADD CONSTRAINT "page_ancestors_ancestor_id_pages_id_fk" FOREIGN KEY ("ancestor_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_links" ADD CONSTRAINT "page_links_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_links" ADD CONSTRAINT "page_links_target_page_id_pages_id_fk" FOREIGN KEY ("target_page_id") REFERENCES "public"."pages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_member_sources" ADD CONSTRAINT "page_member_sources_paper_id_pages_id_fk" FOREIGN KEY ("paper_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_members" ADD CONSTRAINT "page_members_scope_page_id_pages_id_fk" FOREIGN KEY ("scope_page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_members" ADD CONSTRAINT "page_members_paper_id_pages_id_fk" FOREIGN KEY ("paper_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_parents" ADD CONSTRAINT "page_parents_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_scope_names" ADD CONSTRAINT "page_scope_names_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "page_ancestors_ancestor_idx" ON "page_ancestors" USING btree ("ancestor_id");--> statement-breakpoint
CREATE INDEX "page_links_target_idx" ON "page_links" USING btree ("target");--> statement-breakpoint
CREATE INDEX "page_links_target_page_idx" ON "page_links" USING btree ("target_page_id");--> statement-breakpoint
CREATE INDEX "page_member_sources_source_idx" ON "page_member_sources" USING btree ("source");--> statement-breakpoint
CREATE INDEX "page_members_paper_idx" ON "page_members" USING btree ("paper_id");--> statement-breakpoint
CREATE INDEX "page_scope_names_name_idx" ON "page_scope_names" USING btree ("name");