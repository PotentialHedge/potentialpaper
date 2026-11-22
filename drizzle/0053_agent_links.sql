CREATE TABLE "agent_links" (
	"id" text PRIMARY KEY NOT NULL,
	"secret_hash" text NOT NULL,
	"agent" text DEFAULT '' NOT NULL,
	"user_id" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "agent_links_secret_hash_unique" UNIQUE("secret_hash")
);
--> statement-breakpoint
ALTER TABLE "agent_links" ADD CONSTRAINT "agent_links_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;