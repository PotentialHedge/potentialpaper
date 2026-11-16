CREATE TABLE "consumer_cursors" (
	"name" text PRIMARY KEY NOT NULL,
	"last_xid" "xid8" DEFAULT '0' NOT NULL,
	"last_event_id" bigint DEFAULT 0 NOT NULL,
	"leased_until" timestamp with time zone,
	"last_error" text,
	"failed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "page_events" ADD COLUMN "xid" "xid8" DEFAULT pg_current_xact_id() NOT NULL;--> statement-breakpoint
CREATE INDEX "page_events_xid_id_idx" ON "page_events" USING btree ("xid","id");