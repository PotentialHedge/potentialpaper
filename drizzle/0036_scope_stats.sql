CREATE TABLE "scope_state" (
	"scope_page_id" uuid PRIMARY KEY NOT NULL,
	"changed_at" timestamp with time zone NOT NULL,
	"dirty_since" timestamp with time zone,
	"due_at" timestamp with time zone,
	"computed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "scope_stats" (
	"scope_page_id" uuid NOT NULL,
	"venue_id" text NOT NULL,
	"field" text NOT NULL,
	"label" text NOT NULL,
	"position" integer NOT NULL,
	"min" double precision,
	"max" double precision,
	"count" integer NOT NULL,
	"values" double precision[] NOT NULL,
	"bins" jsonb NOT NULL,
	"by_status" jsonb NOT NULL,
	"decisions_out" boolean NOT NULL,
	"computed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "scope_stats_scope_page_id_venue_id_field_pk" PRIMARY KEY("scope_page_id","venue_id","field")
);
--> statement-breakpoint
ALTER TABLE "scope_state" ADD CONSTRAINT "scope_state_scope_page_id_pages_id_fk" FOREIGN KEY ("scope_page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scope_stats" ADD CONSTRAINT "scope_stats_scope_page_id_pages_id_fk" FOREIGN KEY ("scope_page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "scope_state_due_idx" ON "scope_state" USING btree ("due_at");