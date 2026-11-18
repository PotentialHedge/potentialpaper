CREATE TABLE "signal_labels" (
	"set_id" text NOT NULL,
	"generation" integer NOT NULL,
	"signal" text NOT NULL,
	"key" text NOT NULL,
	"title" text NOT NULL,
	CONSTRAINT "signal_labels_set_id_generation_signal_key_pk" PRIMARY KEY("set_id","generation","signal","key")
);
--> statement-breakpoint
CREATE TABLE "signal_sets" (
	"id" text PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"commit" text NOT NULL,
	"publisher_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"live_generation" integer DEFAULT 1 NOT NULL,
	"staged_generation" integer,
	"changed_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "signal_values" (
	"set_id" text NOT NULL,
	"generation" integer NOT NULL,
	"signal" text NOT NULL,
	"scheme" text NOT NULL,
	"value" text NOT NULL,
	"num" real,
	"label" text,
	"vec" real[],
	"updated_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "signal_values_set_id_generation_signal_scheme_value_pk" PRIMARY KEY("set_id","generation","signal","scheme","value")
);
--> statement-breakpoint
CREATE TABLE "signals" (
	"set_id" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"spec" jsonb NOT NULL,
	CONSTRAINT "signals_set_id_name_pk" PRIMARY KEY("set_id","name"),
	CONSTRAINT "signals_kind_check" CHECK (kind in ('vector', 'number', 'label'))
);
--> statement-breakpoint
ALTER TABLE "signal_labels" ADD CONSTRAINT "signal_labels_set_id_signal_sets_id_fk" FOREIGN KEY ("set_id") REFERENCES "public"."signal_sets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signal_sets" ADD CONSTRAINT "signal_sets_publisher_id_accounts_id_fk" FOREIGN KEY ("publisher_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signal_values" ADD CONSTRAINT "signal_values_set_id_signal_sets_id_fk" FOREIGN KEY ("set_id") REFERENCES "public"."signal_sets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signals" ADD CONSTRAINT "signals_set_id_signal_sets_id_fk" FOREIGN KEY ("set_id") REFERENCES "public"."signal_sets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "signal_values_paper_idx" ON "signal_values" USING btree ("scheme","value");