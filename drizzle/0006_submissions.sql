CREATE TABLE "submission_notes" (
	"submission_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"reply_to" text,
	"kind" text NOT NULL,
	"invitation" text NOT NULL,
	"signature" text NOT NULL,
	"content" jsonb NOT NULL,
	"license" text NOT NULL,
	"url" text,
	"created_at" timestamp with time zone NOT NULL,
	"modified_at" timestamp with time zone,
	CONSTRAINT "submission_notes_submission_id_external_id_pk" PRIMARY KEY("submission_id","external_id"),
	CONSTRAINT "submission_notes_kind_check" CHECK (kind in ('review', 'meta_review', 'decision', 'comment', 'withdrawal', 'other'))
);
--> statement-breakpoint
CREATE TABLE "submissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"paper_id" uuid NOT NULL,
	"venue_id" text NOT NULL,
	"external_id" text NOT NULL,
	"number" integer,
	"status" text,
	"decision" text,
	"url" text,
	"fetched_at" timestamp with time zone NOT NULL,
	CONSTRAINT "submissions_status_check" CHECK (status in ('under_review', 'accepted', 'rejected', 'withdrawn', 'desk_rejected'))
);
--> statement-breakpoint
CREATE TABLE "venues" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"url" text,
	"forms" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "submission_notes" ADD CONSTRAINT "submission_notes_submission_id_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."submissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_paper_id_papers_id_fk" FOREIGN KEY ("paper_id") REFERENCES "public"."papers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_venue_id_venues_id_fk" FOREIGN KEY ("venue_id") REFERENCES "public"."venues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "submissions_venue_external_key" ON "submissions" USING btree ("venue_id","external_id");--> statement-breakpoint
CREATE INDEX "submissions_paper_id_idx" ON "submissions" USING btree ("paper_id");