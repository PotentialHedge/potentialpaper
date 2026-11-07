ALTER TABLE "papers" ADD COLUMN "source" text;--> statement-breakpoint
ALTER TABLE "papers" ADD COLUMN "metadata_license" text;--> statement-breakpoint
ALTER TABLE "papers" ADD COLUMN "abstract_license" text;--> statement-breakpoint
ALTER TABLE "papers" ADD CONSTRAINT "papers_source_check" CHECK ("papers"."source" in ('arxiv', 'openalex', 'openreview'));--> statement-breakpoint
-- Backfill rows whose source can be told from their identifiers. A paper with both an arXiv id and a DOI
-- could have come from either, so it stays null, and so does an OpenAlex abstract's license.
UPDATE "papers" p SET "source" = 'openreview', "metadata_license" = 'CC0-1.0',
  "abstract_license" = CASE WHEN p."abstract" IS NULL THEN NULL ELSE 'CC0-1.0' END
WHERE EXISTS (SELECT 1 FROM "paper_identifiers" i WHERE i."paper_id" = p."id" AND i."scheme" = 'openreview');--> statement-breakpoint
UPDATE "papers" p SET "source" = 'arxiv', "metadata_license" = 'CC0-1.0',
  "abstract_license" = CASE WHEN p."abstract" IS NULL THEN NULL ELSE 'CC0-1.0' END
WHERE p."source" IS NULL
  AND EXISTS (SELECT 1 FROM "paper_identifiers" i WHERE i."paper_id" = p."id" AND i."scheme" = 'arxiv')
  AND NOT EXISTS (SELECT 1 FROM "paper_identifiers" i WHERE i."paper_id" = p."id" AND i."scheme" = 'doi');--> statement-breakpoint
UPDATE "papers" p SET "source" = 'openalex', "metadata_license" = 'CC0-1.0'
WHERE p."source" IS NULL
  AND EXISTS (SELECT 1 FROM "paper_identifiers" i WHERE i."paper_id" = p."id" AND i."scheme" = 'doi')
  AND NOT EXISTS (SELECT 1 FROM "paper_identifiers" i WHERE i."paper_id" = p."id" AND i."scheme" = 'arxiv');
