CREATE TABLE "pdf_documents" (
	"sha256" text PRIMARY KEY NOT NULL,
	"url" text NOT NULL,
	"bytes" integer,
	"pages" integer,
	"first_page_raw" text,
	"first_page_layout" text,
	"emails" text[] DEFAULT '{}'::text[] NOT NULL,
	"cover_url" text,
	"stages" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "author_claims" ADD COLUMN "method" text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "author_claims" ADD COLUMN "verification" jsonb;--> statement-breakpoint
CREATE INDEX "pdf_documents_emails_idx" ON "pdf_documents" USING gin ("emails");--> statement-breakpoint
ALTER TABLE "author_claims" ADD CONSTRAINT "author_claims_method_check" CHECK (method in ('manual', 'email', 'vouch'));