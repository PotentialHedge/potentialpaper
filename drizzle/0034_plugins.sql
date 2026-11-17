CREATE TABLE "plugin_refs" (
	"source" text NOT NULL,
	"ref" text NOT NULL,
	"commit" text NOT NULL,
	"resolved_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plugin_refs_source_ref_pk" PRIMARY KEY("source","ref")
);
--> statement-breakpoint
CREATE TABLE "plugin_snapshots" (
	"source" text NOT NULL,
	"commit" text NOT NULL,
	"plugin_id" text NOT NULL,
	"host" text NOT NULL,
	"manifest" jsonb NOT NULL,
	"warnings" jsonb NOT NULL,
	"files" jsonb NOT NULL,
	"total_bytes" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "plugin_snapshots_source_commit_pk" PRIMARY KEY("source","commit")
);
--> statement-breakpoint
CREATE TABLE "user_plugin_grants" (
	"account_id" uuid NOT NULL,
	"plugin_id" text NOT NULL,
	"sha" text NOT NULL,
	"permissions" text[] NOT NULL,
	"network" text[] NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_plugin_grants_account_id_plugin_id_pk" PRIMARY KEY("account_id","plugin_id")
);
--> statement-breakpoint
CREATE TABLE "user_plugin_storage" (
	"account_id" uuid NOT NULL,
	"plugin_id" text NOT NULL,
	"data" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_plugin_storage_account_id_plugin_id_pk" PRIMARY KEY("account_id","plugin_id")
);
--> statement-breakpoint
ALTER TABLE "user_plugin_grants" ADD CONSTRAINT "user_plugin_grants_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_plugin_storage" ADD CONSTRAINT "user_plugin_storage_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "plugin_snapshots_host_commit" ON "plugin_snapshots" USING btree ("host","commit");