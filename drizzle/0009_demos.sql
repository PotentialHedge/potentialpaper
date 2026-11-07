CREATE TABLE "demo_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"commit" text NOT NULL,
	"root" text NOT NULL,
	"files" jsonb NOT NULL,
	"total_bytes" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "page_current" ADD COLUMN "demos" jsonb;