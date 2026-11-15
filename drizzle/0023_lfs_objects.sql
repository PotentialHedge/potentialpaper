CREATE TABLE "lfs_objects" (
	"sha256" text PRIMARY KEY NOT NULL,
	"bytes" bigint NOT NULL,
	"type" text NOT NULL,
	"url" text NOT NULL,
	"account_id" uuid,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "lfs_objects" ADD CONSTRAINT "lfs_objects_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- The files pages already point at, and PDFs uploaded or copied for versions, so the move to Git LFS pointers
-- (`npm run pages:migrate-lfs`) finds each one here.
INSERT INTO "lfs_objects" ("sha256", "bytes", "type", "url")
SELECT DISTINCT ON (sha256) sha256, bytes, type, url FROM (
	SELECT pdf->>'sha256' AS sha256, (pdf->>'bytes')::bigint AS bytes, 'application/pdf' AS type, pdf->>'url' AS url, 1 AS rank
		FROM page_current WHERE pdf ? 'sha256' AND pdf ? 'bytes'
	UNION ALL
	SELECT v->'pdf'->>'sha256', (v->'pdf'->>'bytes')::bigint, 'application/pdf', v->'pdf'->>'url', 2
		FROM page_current, jsonb_array_elements(versions) v WHERE v->'pdf' ? 'sha256'
	UNION ALL
	SELECT thumbnail->>'sha256', (thumbnail->>'bytes')::bigint, thumbnail->>'type', thumbnail->>'url', 3
		FROM page_current WHERE thumbnail ? 'sha256'
	UNION ALL
	SELECT sha256, bytes, type, url, 4 FROM evidence_files WHERE type = 'application/pdf'
	UNION ALL
	SELECT sha256, bytes, 'application/pdf', url, 5 FROM pdf_documents WHERE bytes IS NOT NULL
) files
WHERE sha256 ~ '^[0-9a-f]{64}$'
ORDER BY sha256, rank
ON CONFLICT DO NOTHING;
