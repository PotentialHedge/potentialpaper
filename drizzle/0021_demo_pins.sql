CREATE TABLE "demo_pins" (
	"paper_id" uuid NOT NULL,
	"url" text NOT NULL,
	"snapshot_id" text NOT NULL,
	"commit" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "demo_pins_paper_id_url_pk" PRIMARY KEY("paper_id","url")
);
--> statement-breakpoint
ALTER TABLE "demo_pins" ADD CONSTRAINT "demo_pins_paper_id_papers_id_fk" FOREIGN KEY ("paper_id") REFERENCES "public"."papers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "demo_pins" ADD CONSTRAINT "demo_pins_snapshot_id_demo_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."demo_snapshots"("id") ON DELETE no action ON UPDATE no action;